# llama-server sidecar (llama.cpp)

Tauri bundles **`llama-server`** from this folder. See [`client/src-tauri/src/llama_server.rs`](../src/llama_server.rs) for spawn/stop commands.

## Step A — Build `llama-server` on Windows 11 (AVX2 / VNNI)

On a **Windows 11** dev machine with **CMake** and **Visual Studio Build Tools** (MSVC):

1. Clone **[ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp)** (or your fork).
2. Configure with CPU features enabled (MSVC):

   ```bat
   cmake -B build -DCMAKE_BUILD_TYPE=Release ^
     -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_VNNI=ON
   cmake --build build --config Release -j
   ```

   Adjust flags to match your **llama.cpp** CMake options (`-DGGML_NATIVE=ON` can tune for the local CPU instead).

3. Copy the built server binary to this repo:

   - From `build/bin/Release/llama-server.exe` (path may vary), copy to:

     `client/src-tauri/binaries/llama-server-x86_64-pc-windows-msvc.exe`

   Tauri expects the **`TARGET_TRIPLE`** suffix. Check with:

   ```bat
   rustc --print host-tuple
   ```

   For Windows MSVC amd64 this is usually `x86_64-pc-windows-msvc`.

4. **macOS / Linux** developers: place the corresponding triple file (e.g. `llama-server-aarch64-apple-darwin`) next to the Windows binary for cross-bundle workflows, or build only on Windows for POS installers.

## Step B — Already wired

[`tauri.conf.json`](../tauri.conf.json) lists `"externalBin": ["binaries/llama-server"]`.

## Step C — Runtime (orchestrator)

From the desktop shell, after setting **`RIVERSIDE_LLAMA_MODEL_PATH`** to a `.gguf` file:

| Invoke | Purpose |
|--------|---------|
| `rosie_llama_start` | Spawns sidecar (`-m`, `--host`/`--port` from env). |
| `rosie_llama_stop` | Kills the embedded process. |
| `rosie_llama_status` | Whether this app still holds the child handle. |

Optional env:

| Variable | Default | Notes |
|----------|---------|--------|
| `RIVERSIDE_LLAMA_HOST` | `127.0.0.1` | HTTP bind for OpenAI-compatible API. |
| `RIVERSIDE_LLAMA_PORT` | `8080` | Match your client HTTP port. |
| `RIVERSIDE_LLAMA_MMPROJ_PATH` | (unset) | **LLaVA**: path to `mmproj` file; passed as `--mmproj`. |

Frontend can call these via `@tauri-apps/plugin-shell` later; the Rust API is sufficient for ROSIE integration.

## LLaVA + Playwright (vision tip)

For **multimodal** analysis of ROS screenshots, build a **llama.cpp** server with **LLaVA** support, set **`RIVERSIDE_LLAMA_MMPROJ_PATH`**, and POST images per **[llama.cpp server multimodal](https://github.com/ggml-org/llama.cpp/blob/master/examples/server/README.md)** (API evolves with upstream).

Production POS should still prefer **Tauri-first** or structured UI context per **`docs/PLAN_LOCAL_LLM_HELP.md`**; Playwright + LLaVA is best for **engineering / QA** rigs.

## License

Ensure your **llama.cpp** and model **GGUF** artifacts comply with upstream and model card terms.
