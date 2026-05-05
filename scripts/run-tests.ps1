param(
  [switch]$Watch,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$VitestArgs
)

$ErrorActionPreference = 'Stop'

if ($Watch) {
  npm test -- @VitestArgs
} else {
  npm test -- --run @VitestArgs
}
