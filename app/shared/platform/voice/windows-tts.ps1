$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    try { $request = $line | ConvertFrom-Json }
    catch { [Console]::Out.WriteLine('{"id":"invalid","error":"INVALID_ARGUMENT"}'); continue }
    if ($request.action -eq 'voices') {
      $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
        [ordered]@{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender }
      })
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ id = $request.id; voices = $voices }) -Compress -Depth 4))
      continue
    }
    if ($request.action -ne 'synthesize' -or [string]::IsNullOrWhiteSpace($request.text) -or $request.text.Length -gt 12000) {
      [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ id = $request.id; error = 'INVALID_TEXT' })))
      continue
    }
    $memory = New-Object System.IO.MemoryStream
    try {
      if ($request.voiceId) { $synth.SelectVoice([string]$request.voiceId) }
      $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$request.rate))
      $synth.SetOutputToWaveStream($memory)
      $synth.Speak([string]$request.text)
      $bytes = $memory.ToArray()
      [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ id = $request.id; wav = [Convert]::ToBase64String($bytes) })))
    } catch {
      $code = if ($_.Exception.Message -match 'voice') { 'TTS_VOICE_UNAVAILABLE' } else { 'TTS_SPEECH_FAILED' }
      [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ id = $request.id; error = $code })))
    } finally {
      $synth.SetOutputToNull()
      $memory.Dispose()
    }
  }
} finally { $synth.Dispose() }
