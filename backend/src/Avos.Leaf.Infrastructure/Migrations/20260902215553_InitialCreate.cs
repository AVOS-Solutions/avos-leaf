using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Avos.Leaf.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "LeafAccounts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    LicenseUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Email = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LeafAccounts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LeafDocuments",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    OwnerAccountId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    FolderId = table.Column<Guid>(type: "uuid", nullable: true),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    PageCount = table.Column<int>(type: "integer", nullable: false),
                    StorageKey = table.Column<string>(type: "text", nullable: false),
                    EncryptedDek = table.Column<string>(type: "text", nullable: false),
                    TrashedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    Starred = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LeafDocuments", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LeafFolders",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    OwnerAccountId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    ParentFolderId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LeafFolders", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "RefreshTokens",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    LeafAccountId = table.Column<Guid>(type: "uuid", nullable: false),
                    TokenHash = table.Column<string>(type: "text", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RefreshTokens", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_LeafAccounts_LicenseUserId",
                table: "LeafAccounts",
                column: "LicenseUserId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LeafDocuments_FolderId",
                table: "LeafDocuments",
                column: "FolderId");

            migrationBuilder.CreateIndex(
                name: "IX_LeafDocuments_OwnerAccountId",
                table: "LeafDocuments",
                column: "OwnerAccountId");

            migrationBuilder.CreateIndex(
                name: "IX_LeafFolders_OwnerAccountId",
                table: "LeafFolders",
                column: "OwnerAccountId");

            migrationBuilder.CreateIndex(
                name: "IX_LeafFolders_ParentFolderId",
                table: "LeafFolders",
                column: "ParentFolderId");

            migrationBuilder.CreateIndex(
                name: "IX_RefreshTokens_LeafAccountId",
                table: "RefreshTokens",
                column: "LeafAccountId");

            migrationBuilder.CreateIndex(
                name: "IX_RefreshTokens_TokenHash",
                table: "RefreshTokens",
                column: "TokenHash",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "LeafAccounts");

            migrationBuilder.DropTable(
                name: "LeafDocuments");

            migrationBuilder.DropTable(
                name: "LeafFolders");

            migrationBuilder.DropTable(
                name: "RefreshTokens");
        }
    }
}
