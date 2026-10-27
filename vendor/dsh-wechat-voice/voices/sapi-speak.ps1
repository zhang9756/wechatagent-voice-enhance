# Offline voice synthesis through Windows SAPI (System.Speech).
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless BOM.
# Text is always passed through a UTF-8 file, never on the command line.
#
#   powershell -File sapi-speak.ps1 -TextFile t.txt -Out v.wav -Voice "Microsoft Yaoyao" -Rate 0 -Volume 100
#   powershell -File sapi-speak.ps1 -List -Out voices.json
#
# Exit codes: 0 ok, 2 bad arguments, 3 no speech engine, 4 voice missing,
#             5 empty text, 6 synthesis failed.
param(
    [string]$TextFile = '',
    [string]$Out = '',
    [string]$Voice = '',
    [int]$Rate = 0,
    [int]$Volume = 100,
    [int]$SampleRate = 22050,
    [switch]$List
)
$ErrorActionPreference = 'Stop'

function Fail([int]$code, [string]$message) {
    if ($Out) { try { [IO.File]::WriteAllText($Out + '.err', $message, (New-Object Text.UTF8Encoding($false))) } catch { } }
    [Console]::Error.WriteLine($message)
    exit $code
}

if (-not $Out) { Fail 2 'missing -Out' }

try { Add-Type -AssemblyName System.Speech } catch { Fail 3 ('System.Speech unavailable: ' + $_.Exception.Message) }

try { $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer } catch { Fail 3 ('SpeechSynthesizer unavailable: ' + $_.Exception.Message) }

try {
    if ($List) {
        $rows = @()
        foreach ($installed in $synth.GetInstalledVoices()) {
            $info = $installed.VoiceInfo
            $rows += [pscustomobject]@{
                name    = [string]$info.Name
                culture = [string]$info.Culture.Name
                gender  = [string]$info.Gender
                age     = [string]$info.Age
                enabled = [bool]$installed.Enabled
            }
        }
        $parts = @()
        foreach ($row in $rows) { $parts += ($row | ConvertTo-Json -Compress -Depth 4) }
        [IO.File]::WriteAllText($Out, ('[' + ($parts -join ',') + ']'), (New-Object Text.UTF8Encoding($false)))
        exit 0
    }

    if (-not $TextFile) { Fail 2 'missing -TextFile' }
    if (-not (Test-Path -LiteralPath $TextFile)) { Fail 2 ('text file not found: ' + $TextFile) }
    $text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($text)) { Fail 5 'empty text' }

    if ($Voice) {
        $names = @()
        foreach ($installed in $synth.GetInstalledVoices()) { if ($installed.Enabled) { $names += [string]$installed.VoiceInfo.Name } }
        if ($names -notcontains $Voice) { Fail 4 ('voice not installed: ' + $Voice + ' available: ' + ($names -join ' / ')) }
        $synth.SelectVoice($Voice)
    }

    if ($Rate -lt -10) { $Rate = -10 }
    if ($Rate -gt 10) { $Rate = 10 }
    if ($Volume -lt 0) { $Volume = 0 }
    if ($Volume -gt 100) { $Volume = 100 }
    $synth.Rate = $Rate
    $synth.Volume = $Volume

    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        $SampleRate,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
    $directory = [IO.Path]::GetDirectoryName($Out)
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $synth.SetOutputToWaveFile($Out, $format)
    $synth.Speak($text)
    $synth.SetOutputToNull()
    exit 0
} catch {
    Fail 6 ('synthesis failed: ' + $_.Exception.Message)
} finally {
    try { $synth.Dispose() } catch { }
}
