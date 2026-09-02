using System.Text;
using Avos.Leaf.Api.Services;
using Avos.Leaf.Api.Ws;
using Avos.Leaf.Infrastructure.Persistence;
using Avos.Leaf.Infrastructure.Security;
using Avos.Leaf.Infrastructure.Storage;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration["ConnectionStrings:Default"]
    ?? throw new InvalidOperationException("ConnectionStrings:Default is not configured.");
var encryptionKey = builder.Configuration["Leaf:EncryptionKey"]
    ?? throw new InvalidOperationException("Leaf:EncryptionKey is not configured.");
var jwtKey = builder.Configuration["Jwt:Key"]
    ?? throw new InvalidOperationException("Jwt:Key is not configured.");
var jwtIssuer = builder.Configuration["Jwt:Issuer"]
    ?? throw new InvalidOperationException("Jwt:Issuer is not configured.");
var jwtAudience = builder.Configuration["Jwt:Audience"]
    ?? throw new InvalidOperationException("Jwt:Audience is not configured.");

builder.Services.AddSingleton<IEncryptionService>(new AesGcmEncryptionService(encryptionKey));
builder.Services.AddSingleton<IFileEncryptionService, LeafFileEncryptionService>();
builder.Services.AddSingleton<IBlobStorageService, LocalBlobStorageService>();
builder.Services.AddDbContext<LeafDbContext>(options => options.UseNpgsql(connectionString));

builder.Services
    .AddAuthentication(options =>
    {
        options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
        options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
    })
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwtIssuer,
            ValidAudience = jwtAudience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            ClockSkew = TimeSpan.FromSeconds(30),
        };

        // A raw WebSocket upgrade request from a browser cannot carry an Authorization header — so
        // for /ws/leafs only, accept the JWT as an `access_token` query-string parameter instead.
        // Same idiom as avos-quill's /ws/documents and avos-slate's /ws/workbooks (see their own
        // Program.cs).
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                if (context.HttpContext.Request.Path.StartsWithSegments("/ws/leafs"))
                {
                    var token = context.Request.Query["access_token"].ToString();
                    if (!string.IsNullOrEmpty(token))
                    {
                        context.Token = token;
                    }
                }
                return Task.CompletedTask;
            },
        };
    });

builder.Services.AddAuthorization(options =>
{
    // Every avos-leaf account is a paying customer — there's no staff/admin role split, so a bare
    // [Authorize] just means "any logged-in account." Same convention as avos-vault.
    options.AddPolicy("AnyAccount", policy => policy.RequireAuthenticatedUser());
    options.DefaultPolicy = options.GetPolicy("AnyAccount")!;
    // FallbackPolicy protects any endpoint with no [Authorize] attribute at all (e.g. AccountController),
    // while AuthController's explicitly [AllowAnonymous] actions stay open.
    options.FallbackPolicy = options.GetPolicy("AnyAccount")!;
});

builder.Services.AddScoped<TokenService>();
builder.Services.AddScoped<IdentityLicensingClient>();
builder.Services.AddHttpClient(nameof(IdentityLicensingClient));
builder.Services.AddSingleton<LeafRoomManager>();
builder.Services.AddSingleton<LeafCollaborationHandler>();

var frontendOrigin = builder.Configuration["Cors:FrontendOrigin"] ?? "http://localhost:3200";
builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
        policy.WithOrigins(frontendOrigin).AllowAnyHeader().AllowAnyMethod());
});

builder.Services.AddControllers()
    .AddJsonOptions(options =>
        options.JsonSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<LeafDbContext>();
    await db.Database.MigrateAsync();
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseCors("Frontend");
app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(30),
});
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();
app.MapControllers();

// The real-time collaboration relay for one leaf's Standard-tier (vault) content — see
// Ws/LeafCollaborationHandler for the full protocol and LeafRoomManager's doc comment for why
// HistoryId (a client-minted string, not a database key) is the room identity and why that's a
// deliberate reuse of an existing trust boundary rather than a new ACL. Requires a real account's
// access token, same "any authenticated account" policy as every other endpoint here — there is no
// anonymous live collaboration.
app.Map("/ws/leafs/{historyId}", async (HttpContext context, string historyId, LeafCollaborationHandler handler) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var user = context.User;
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    await handler.HandleAsync(historyId, user.GetAccountId(), socket, context.RequestAborted);
}).RequireAuthorization("AnyAccount");

app.Run();
