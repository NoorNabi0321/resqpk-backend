# Test audio clips

Drop your Module 6 voice samples here as `.mp3` / `.m4a` / `.wav`, e.g.:

- `clip1-en-cardiac.mp3`
- `clip2-ur-stroke.mp3`
- `clip3-sd-trauma.mp3`
- `clip4-mix-asthma.mp3`

Then run the pipeline test from the backend root:

```
node ai-pipeline-test.mjs
```

It transcribes each clip (Whisper) and generates a triage report (GPT) — no
database or running server needed. Used for Module 6 B8 + the E1 evaluation suite.
