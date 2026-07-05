param(
  [Parameter(Mandatory = $true)]
  [string]$ClientId,

  [string]$GuildId = "",

  [switch]$Admin
)

$ErrorActionPreference = "Stop"

$permissions = if ($Admin) { "8" } else { "36719680" }
$query = @{
  client_id = $ClientId
  permissions = $permissions
  scope = "bot applications.commands"
}

if ($GuildId) {
  $query.guild_id = $GuildId
  $query.disable_guild_select = "true"
}

$encoded = $query.GetEnumerator() |
  Sort-Object Name |
  ForEach-Object {
    "{0}={1}" -f [uri]::EscapeDataString($_.Key), [uri]::EscapeDataString([string]$_.Value)
  }

"https://discord.com/oauth2/authorize?$($encoded -join '&')"
