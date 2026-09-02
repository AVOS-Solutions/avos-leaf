using Avos.Leaf.Api.Contracts;
using Avos.Leaf.Api.Services;
using Avos.Leaf.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Avos.Leaf.Api.Controllers;

[ApiController]
[Route("api/account")]
public class AccountController(LeafDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<AccountSummaryDto>> Get()
    {
        var accountId = User.GetAccountId();
        var account = await db.LeafAccounts.FirstOrDefaultAsync(a => a.Id == accountId);
        if (account is null) return NotFound();

        return Ok(new AccountSummaryDto(account.Id, account.Email, account.DisplayName));
    }
}
