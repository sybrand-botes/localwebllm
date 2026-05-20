import { pipeline, TextStreamer, env }
  from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

// GitHub Pages has no COOP/COEP headers — force single-thread WASM
env.backends.onnx.wasm.numThreads = 1;

let generator = null;

self.addEventListener('message', async ({ data }) => {
  const { type, payload } = data;

  // ── Load model ────────────────────────────────────────────────────────────
  if (type === 'load') {
    const { device, dtype } = payload;
    try {
      generator = await pipeline(
        'text-generation',
        'HuggingFaceTB/SmolLM2-360M-Instruct',
        {
          device,
          dtype,
          progress_callback: (p) => self.postMessage({ type: 'progress', payload: p }),
        }
      );
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', payload: String(err?.message ?? err) });
    }
    return;
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  if (type === 'generate') {
    const { messages } = payload;
    try {
      const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk) => {
          self.postMessage({ type: 'token', payload: chunk });
        },
      });

      await generator(messages, {
        max_new_tokens: 256,
        do_sample: false,
        repetition_penalty: 1.3,
        no_repeat_ngram_size: 3, // blocks exact 3-token phrase repetition
        streamer,
      });

      self.postMessage({ type: 'done' });
    } catch (err) {
      self.postMessage({ type: 'error', payload: String(err?.message ?? err) });
    }
  }
});
