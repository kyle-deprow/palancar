# Security-ops smoke audio fixtures

These files are deterministic synthetic speech generated solely for the live
Spanish and Turkish security-operations smoke. They contain no user audio,
personal data, credentials, or other sensitive material.

## Provenance

| Fixture | Language | Exact phrase | Original WAV SHA-256 | Final PCM SHA-256 | Final bytes |
| --- | --- | --- | --- | --- | ---: |
| `smoke-es-spanish.pcm` | Spanish (`es`) | `Buenos días, ¿dónde está la estación?` | `5264956d332d77f7b026ba9041469b050c79af9757f706ef5b46a631f15fb6f1` | `2acdb87adc12791634b1c8c9602ba20abc62621f2d6184a3d60a62787ccd7357` | 96,000 |
| `smoke-tr-turkish.pcm` | Turkish (`tr`) | `Merhaba, tren istasyonu nerede?` | `eb7f6bb7338aa6b6f77c50fdb56cd4ba4bde203c50606536757a2ee0a70e893d` | `fa0357cf46980fb436140105a6d7ecdd06ad7abc0f7fd8fdcf27ef9c47de7d6a` | 102,400 |

Both source WAV files were synthesized with eSpeak-NG 1.51 at speed 145. The
final fixtures are headerless signed 16-bit little-endian PCM, mono, 16 kHz.
Each file is padded to an exact 100 ms boundary: 1,600 samples or 3,200 bytes
per frame.

## Reproduction procedure

1. Synthesize each exact phrase with eSpeak-NG 1.51 at speed 145 into its
   original mono 22,050 Hz WAV file.
2. Decode the WAV's signed 16-bit samples and linearly resample from 22,050 Hz
   to 16,000 Hz. For each output sample, map its source position by the exact
   sample-rate ratio, interpolate the adjacent source samples, round to the
   nearest signed integer, and clamp to the 16-bit range.
3. Append zero-valued samples to the next 1,600-sample boundary.
4. Write only the samples as signed 16-bit little-endian mono PCM, without a
   container header.
5. Verify the original WAV and final PCM SHA-256 values and final byte lengths
   listed above.

eSpeak-NG is a fixture-generation tool only. Security-ops has no runtime TTS
dependency.
