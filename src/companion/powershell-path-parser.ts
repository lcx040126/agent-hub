import { spawnSync } from "node:child_process";

export interface PowerShellWriteTarget {
  pathCandidate: string;
  operation: "add" | "update" | "delete" | "move";
}

export interface PowerShellPathParseResult {
  pathCandidates: string[];
  targets: PowerShellWriteTarget[];
  diagnostics: string[];
}

interface SerializedPowerShellResult {
  pathCandidates?: unknown;
  targets?: unknown;
  diagnostics?: unknown;
}

// Windows PowerShell 冷启动在全量串行测试或构建负载下可能超过 2.5 秒。
// 该解析器位于 PreToolUse，不占用 Stop 的三秒预算；这里为进程启动留出余量，真实卡死时仍保持失败关闭。
const PARSER_TIMEOUT_MS = 5_000;
const PARSER_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

const POWERSHELL_STDIN_LAUNCHER = String.raw`
$encodedPayload = [Console]::In.ReadToEnd()
$payloadJson = [System.Text.Encoding]::UTF8.GetString(
  [System.Convert]::FromBase64String($encodedPayload)
)
$payload = $payloadJson | ConvertFrom-Json
& ([ScriptBlock]::Create([string]$payload.parser)) -Source ([string]$payload.source)
`;

// 该脚本只遍历 AST，不执行待分析命令。仅字面量、单次常量赋值与参数均可证明的 Join-Path 会产出路径。
const POWERSHELL_AST_PARSER = String.raw`
param([string]$Source)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($null -eq $Source) { $Source = '' }
$tokens = $null
$parseErrors = $null
$root = [System.Management.Automation.Language.Parser]::ParseInput(
  $Source,
  [ref]$tokens,
  [ref]$parseErrors
)

$script:variables = @{}
$script:targets = [System.Collections.Generic.List[object]]::new()
$script:diagnostics = [System.Collections.Generic.List[string]]::new()
$script:switchParameters = @(
  'append',
  'asbytestream',
  'confirm',
  'container',
  'debug',
  'force',
  'noclobber',
  'nonewline',
  'passthru',
  'recurse',
  'usetransaction',
  'verbose',
  'wait',
  'whatif'
)

function New-Resolution([bool]$resolved, [object[]]$values, [string]$reason) {
  return [pscustomobject]@{
    Resolved = $resolved
    Values = @($values)
    Reason = $reason
  }
}

function Normalize-CommandName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return '' }
  return ($name -split '[\\/]')[-1].ToLowerInvariant()
}

function Read-CommandArguments($command) {
  $parameters = @{}
  $positionals = [System.Collections.Generic.List[object]]::new()
  $elements = @($command.CommandElements)
  for ($index = 1; $index -lt $elements.Count; $index++) {
    $element = $elements[$index]
    if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
      $key = $element.ParameterName.ToLowerInvariant()
      if ($script:switchParameters -contains $key) {
        $parameters[$key] = @()
      } elseif ($null -ne $element.Argument) {
        $parameters[$key] = @($element.Argument)
      } elseif (
        $index + 1 -lt $elements.Count -and
        $elements[$index + 1] -isnot [System.Management.Automation.Language.CommandParameterAst]
      ) {
        $index++
        $parameters[$key] = @($elements[$index])
      } else {
        $parameters[$key] = @()
      }
    } else {
      $positionals.Add($element)
    }
  }
  return [pscustomobject]@{ Parameters = $parameters; Positionals = @($positionals) }
}

function Resolve-JoinPath($command) {
  $arguments = Read-CommandArguments $command
  $parentNodes = if ($arguments.Parameters.ContainsKey('path')) {
    @($arguments.Parameters['path'])
  } elseif ($arguments.Positionals.Count -gt 0) {
    @($arguments.Positionals[0])
  } else { @() }
  $childNodes = if ($arguments.Parameters.ContainsKey('childpath')) {
    @($arguments.Parameters['childpath'])
  } elseif ($arguments.Positionals.Count -gt 1) {
    @($arguments.Positionals[1])
  } else { @() }
  $additionalNodes = if ($arguments.Parameters.ContainsKey('additionalchildpath')) {
    @($arguments.Parameters['additionalchildpath'])
  } elseif ($arguments.Positionals.Count -gt 2) {
    @($arguments.Positionals | Select-Object -Skip 2)
  } else { @() }
  if ($parentNodes.Count -eq 0 -or $childNodes.Count -eq 0) {
    return New-Resolution $false @() 'Join-Path requires provable Path and ChildPath values.'
  }

  $parents = [System.Collections.Generic.List[string]]::new()
  foreach ($node in $parentNodes) {
    $resolved = Resolve-AstValue $node
    if (-not $resolved.Resolved) { return $resolved }
    foreach ($value in $resolved.Values) { $parents.Add([string]$value) }
  }
  $children = [System.Collections.Generic.List[string]]::new()
  foreach ($node in $childNodes) {
    $resolved = Resolve-AstValue $node
    if (-not $resolved.Resolved) { return $resolved }
    foreach ($value in $resolved.Values) { $children.Add([string]$value) }
  }
  $additional = [System.Collections.Generic.List[string]]::new()
  foreach ($node in $additionalNodes) {
    $resolved = Resolve-AstValue $node
    if (-not $resolved.Resolved) { return $resolved }
    foreach ($value in $resolved.Values) { $additional.Add([string]$value) }
  }

  $joined = [System.Collections.Generic.List[string]]::new()
  foreach ($parent in $parents) {
    foreach ($child in $children) {
      $current = [System.IO.Path]::Combine($parent, $child)
      foreach ($part in $additional) { $current = [System.IO.Path]::Combine($current, $part) }
      $joined.Add($current)
    }
  }
  return New-Resolution $true @($joined) ''
}

function Resolve-AstValue($node) {
  if ($null -eq $node) { return New-Resolution $false @() 'The path argument is missing.' }
  if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
    return New-Resolution $true @([string]$node.Value) ''
  }
  if ($node -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
    if ($node.NestedExpressions.Count -eq 0) {
      return New-Resolution $true @([string]$node.Value) ''
    }
    return New-Resolution $false @() 'Interpolated strings are not statically provable.'
  }
  if (
    $node -is [System.Management.Automation.Language.ConstantExpressionAst] -and
    $node.Value -is [string]
  ) {
    return New-Resolution $true @([string]$node.Value) ''
  }
  if ($node -is [System.Management.Automation.Language.VariableExpressionAst]) {
    $name = $node.VariablePath.UserPath.ToLowerInvariant()
    if ($script:variables.ContainsKey($name)) {
      $entry = $script:variables[$name]
      if ([int]$entry.EndOffset -le [int]$node.Extent.StartOffset) {
        return New-Resolution $true @($entry.Values) ''
      }
    }
    return New-Resolution $false @() "Variable '$($node.Extent.Text)' is not a provable local constant."
  }
  if ($node -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $values = [System.Collections.Generic.List[string]]::new()
    foreach ($element in $node.Elements) {
      $resolved = Resolve-AstValue $element
      if (-not $resolved.Resolved) { return $resolved }
      foreach ($value in $resolved.Values) { $values.Add([string]$value) }
    }
    return New-Resolution $true @($values) ''
  }
  if ($node -is [System.Management.Automation.Language.ParenExpressionAst]) {
    return Resolve-AstValue $node.Pipeline
  }
  if ($node -is [System.Management.Automation.Language.CommandExpressionAst]) {
    return Resolve-AstValue $node.Expression
  }
  if ($node -is [System.Management.Automation.Language.PipelineAst]) {
    if ($node.PipelineElements.Count -ne 1) {
      return New-Resolution $false @() 'Pipelines cannot be evaluated as static paths.'
    }
    $element = $node.PipelineElements[0]
    if ($element -is [System.Management.Automation.Language.CommandExpressionAst]) {
      return Resolve-AstValue $element.Expression
    }
    if (
      $element -is [System.Management.Automation.Language.CommandAst] -and
      (Normalize-CommandName $element.GetCommandName()) -eq 'join-path'
    ) {
      return Resolve-JoinPath $element
    }
  }
  return New-Resolution $false @() "Expression '$($node.Extent.Text)' is not statically provable."
}

function Add-Diagnostic([string]$commandName, $node, [string]$reason) {
  $expression = if ($null -eq $node) { '<missing>' } else { [string]$node.Extent.Text }
  if ($expression.Length -gt 160) { $expression = $expression.Substring(0, 160) }
  $message = "$commandName path '$expression' was not attributed: $reason"
  if (-not $script:diagnostics.Contains($message)) { $script:diagnostics.Add($message) }
}

function Add-Target([string]$commandName, $node, [string]$operation, [bool]$literalPath) {
  $resolved = Resolve-AstValue $node
  if (-not $resolved.Resolved) {
    Add-Diagnostic $commandName $node $resolved.Reason
    return
  }
  foreach ($raw in $resolved.Values) {
    $candidate = ([string]$raw).Trim()
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      Add-Diagnostic $commandName $node 'The resolved path is empty.'
      continue
    }
    if (-not $literalPath -and $candidate.IndexOfAny([char[]]'*?[') -ge 0) {
      Add-Diagnostic $commandName $node 'Wildcard paths are not exact collaboration targets.'
      continue
    }
    $script:targets.Add([pscustomobject]@{
      pathCandidate = $candidate
      operation = $operation
    })
  }
}

function Select-ArgumentNodes($arguments, [string[]]$parameterNames, [int[]]$positions) {
  foreach ($name in $parameterNames) {
    $key = $name.ToLowerInvariant()
    if ($arguments.Parameters.ContainsKey($key)) {
      return [pscustomobject]@{
        Nodes = @($arguments.Parameters[$key])
        Literal = $key -eq 'literalpath'
      }
    }
  }
  $nodes = [System.Collections.Generic.List[object]]::new()
  foreach ($position in $positions) {
    if ($position -lt $arguments.Positionals.Count) { $nodes.Add($arguments.Positionals[$position]) }
  }
  return [pscustomobject]@{ Nodes = @($nodes); Literal = $false }
}

function Add-SelectedTargets(
  [string]$commandName,
  $arguments,
  [string[]]$parameterNames,
  [int[]]$positions,
  [string]$operation
) {
  $selection = Select-ArgumentNodes $arguments $parameterNames $positions
  if ($selection.Nodes.Count -eq 0) {
    Add-Diagnostic $commandName $null 'A required path argument was not found.'
    return
  }
  foreach ($node in $selection.Nodes) {
    Add-Target $commandName $node $operation $selection.Literal
  }
}

function Add-RenameTargets([string]$commandName, $arguments) {
  $sourceSelection = Select-ArgumentNodes $arguments @('literalpath', 'path') @(0)
  if ($sourceSelection.Nodes.Count -eq 0) {
    Add-Diagnostic $commandName $null 'A required source path argument was not found.'
    return
  }
  foreach ($node in $sourceSelection.Nodes) {
    Add-Target $commandName $node 'move' $sourceSelection.Literal
  }

  $nameSelection = Select-ArgumentNodes $arguments @('newname') @(1)
  if ($nameSelection.Nodes.Count -eq 0) {
    Add-Diagnostic $commandName $null 'A required NewName argument was not found.'
    return
  }
  $resolvedSources = [System.Collections.Generic.List[string]]::new()
  foreach ($node in $sourceSelection.Nodes) {
    $resolved = Resolve-AstValue $node
    if (-not $resolved.Resolved) { return }
    foreach ($value in $resolved.Values) {
      $candidate = ([string]$value).Trim()
      if (
        -not [string]::IsNullOrWhiteSpace($candidate) -and
        ($sourceSelection.Literal -or $candidate.IndexOfAny([char[]]'*?[') -lt 0)
      ) { $resolvedSources.Add($candidate) }
    }
  }
  foreach ($nameNode in $nameSelection.Nodes) {
    $resolvedNames = Resolve-AstValue $nameNode
    if (-not $resolvedNames.Resolved) {
      Add-Diagnostic $commandName $nameNode $resolvedNames.Reason
      continue
    }
    foreach ($rawName in $resolvedNames.Values) {
      $newName = ([string]$rawName).Trim()
      if (
        [string]::IsNullOrWhiteSpace($newName) -or
        [System.IO.Path]::IsPathRooted($newName) -or
        $newName.IndexOfAny([char[]]'\/') -ge 0
      ) {
        Add-Diagnostic $commandName $nameNode 'NewName must be a statically provable leaf name.'
        continue
      }
      foreach ($source in $resolvedSources) {
        $parent = [System.IO.Path]::GetDirectoryName($source)
        $destination = if ([string]::IsNullOrWhiteSpace($parent)) {
          $newName
        } else {
          [System.IO.Path]::Combine($parent, $newName)
        }
        $script:targets.Add([pscustomobject]@{
          pathCandidate = $destination
          operation = 'move'
        })
      }
    }
  }
}

$assignments = @($root.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left -is [System.Management.Automation.Language.VariableExpressionAst]
}, $true) | Sort-Object { $_.Extent.StartOffset })
$assignmentCounts = @{}
foreach ($assignment in $assignments) {
  $name = $assignment.Left.VariablePath.UserPath.ToLowerInvariant()
  $assignmentCounts[$name] = 1 + [int]($assignmentCounts[$name])
}
foreach ($assignment in $assignments) {
  $name = $assignment.Left.VariablePath.UserPath.ToLowerInvariant()
  if (
    $assignmentCounts[$name] -ne 1 -or
    $assignment.Operator.ToString() -ne 'Equals' -or
    $assignment.Parent -isnot [System.Management.Automation.Language.NamedBlockAst] -or
    $assignment.Parent.Parent -ne $root
  ) { continue }
  $resolved = Resolve-AstValue $assignment.Right
  if ($resolved.Resolved) {
    $script:variables[$name] = [pscustomobject]@{
      Values = @($resolved.Values)
      EndOffset = $assignment.Extent.EndOffset
    }
  }
}

$commands = @($root.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
foreach ($command in $commands) {
  $commandName = Normalize-CommandName $command.GetCommandName()
  if ($commandName -eq 'join-path' -or [string]::IsNullOrWhiteSpace($commandName)) { continue }
  $arguments = Read-CommandArguments $command
  switch ($commandName) {
    { $_ -in @('set-content', 'add-content') } {
      Add-SelectedTargets $commandName $arguments @('literalpath', 'path') @(0) 'update'
      break
    }
    'out-file' {
      Add-SelectedTargets $commandName $arguments @('literalpath', 'filepath') @(0) 'update'
      break
    }
    { $_ -in @('new-item', 'mkdir', 'md') } {
      Add-SelectedTargets $commandName $arguments @('literalpath', 'path') @(0) 'add'
      break
    }
    { $_ -in @('remove-item', 'rm', 'del', 'erase', 'rmdir', 'rd') } {
      Add-SelectedTargets $commandName $arguments @('literalpath', 'path') @(0) 'delete'
      break
    }
    { $_ -in @('move-item', 'mv', 'move') } {
      Add-SelectedTargets $commandName $arguments @('literalpath', 'path') @(0) 'move'
      Add-SelectedTargets $commandName $arguments @('destination') @(1) 'move'
      break
    }
    { $_ -in @('copy-item', 'cp', 'copy', 'xcopy', 'robocopy') } {
      Add-SelectedTargets $commandName $arguments @('destination') @(1) 'update'
      break
    }
    'rename-item' {
      Add-RenameTargets $commandName $arguments
      break
    }
    { $_ -in @('tee-object', 'tee') } {
      Add-SelectedTargets $commandName $arguments @('literalpath', 'filepath') @(0) 'update'
      break
    }
    'touch' {
      if ($arguments.Positionals.Count -eq 0) {
        Add-Diagnostic $commandName $null 'A required path argument was not found.'
      } else {
        foreach ($node in $arguments.Positionals) { Add-Target $commandName $node 'update' $false }
      }
      break
    }
  }
}

$redirections = @($root.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FileRedirectionAst]
}, $true))
foreach ($redirection in $redirections) {
  if (
    $redirection.Location -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $redirection.Location.VariablePath.UserPath -eq 'null'
  ) { continue }
  Add-Target 'redirection' $redirection.Location 'update' $true
}

foreach ($parseError in @($parseErrors)) {
  $message = "PowerShell parse error: $($parseError.Message)"
  if (-not $script:diagnostics.Contains($message)) { $script:diagnostics.Add($message) }
}

$uniqueTargets = @($script:targets | Group-Object {
  [string]$_.operation + [char]0 + $_.pathCandidate.ToLowerInvariant()
} | ForEach-Object { $_.Group[0] })
$result = [pscustomobject]@{
  pathCandidates = @($uniqueTargets.pathCandidate | Select-Object -Unique)
  targets = $uniqueTargets
  diagnostics = @($script:diagnostics)
}
$result | ConvertTo-Json -Compress -Depth 6
`;

export function parsePowerShellWriteTargets(command: string): PowerShellPathParseResult {
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const encodedLauncher = Buffer.from(POWERSHELL_STDIN_LAUNCHER, "utf16le").toString("base64");
  const encodedPayload = Buffer.from(JSON.stringify({
    parser: POWERSHELL_AST_PARSER,
    source: command,
  }), "utf8").toString("base64");
  const parsed = spawnSync(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedLauncher,
  ], {
    input: encodedPayload,
    encoding: "utf8",
    timeout: PARSER_TIMEOUT_MS,
    maxBuffer: PARSER_MAX_BUFFER_BYTES,
    windowsHide: true,
  });

  if (parsed.error || parsed.status !== 0) {
    const reason = parsed.error?.message
      ?? parsed.stderr.trim()
      ?? `PowerShell AST parser exited with status ${String(parsed.status)}.`;
    return {
      pathCandidates: [],
      targets: [],
      diagnostics: [`PowerShell AST parser unavailable: ${reason.slice(0, 500)}`],
    };
  }

  try {
    const payload = JSON.parse(parsed.stdout.trim()) as SerializedPowerShellResult;
    const targets = Array.isArray(payload.targets)
      ? payload.targets.flatMap(parseTarget)
      : [];
    return {
      pathCandidates: unique([
        ...stringArray(payload.pathCandidates),
        ...targets.map((target) => target.pathCandidate),
      ]),
      targets,
      diagnostics: unique(stringArray(payload.diagnostics)).slice(0, 100),
    };
  } catch (error) {
    return {
      pathCandidates: [],
      targets: [],
      diagnostics: [
        `PowerShell AST parser returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function parseTarget(value: unknown): PowerShellWriteTarget[] {
  if (!isRecord(value) || typeof value.pathCandidate !== "string") return [];
  const pathCandidate = value.pathCandidate.trim();
  if (!pathCandidate || !isOperation(value.operation)) return [];
  return [{ pathCandidate, operation: value.operation }];
}

function isOperation(value: unknown): value is PowerShellWriteTarget["operation"] {
  return value === "add" || value === "update" || value === "delete" || value === "move";
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
