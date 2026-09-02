using System.Security.Claims;

namespace Avos.Leaf.Api.Services;

public static class ClaimsPrincipalExtensions
{
    /// <summary>LeafAccount.Id — see TokenService's doc comment on why this is not LicenseUserId.</summary>
    public static Guid GetAccountId(this ClaimsPrincipal principal)
    {
        var sub = principal.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? principal.FindFirstValue("sub")
            ?? throw new InvalidOperationException("No account id claim present on the principal.");
        return Guid.Parse(sub);
    }
}
