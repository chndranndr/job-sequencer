# Issue #24 — Qoder Agent SDK fase 0: hasil spike

Status: **GO bersyarat** untuk fase 1. Semua klaim di bawah berasal dari fixture offline, deklarasi paket, dan artefak terunduh yang diperiksa statis; tidak ada panggilan provider live, tidak ada binary qodercli yang dieksekusi, tidak ada kredensial yang dibaca atau dikirim.

## Artefak yang diperiksa (statis)

| Artefak | Versi | Bukti |
| --- | --- | --- |
| `@qoder-ai/qoder-agent-sdk` | 1.0.49 (latest, dipublikasi 2026-09-23) | tarball npm sha512 `wtNfj0zM…ZLw==` cocok dengan `dist.integrity` registry |
| `qodercli` (binary proses) | 1.1.62, `qodercli-windows-x64.zip` 97.778.572 bytes | sha256 `15978912…e5b5` cocok dengan `channels/1.1.62/manifest.json` (runtime `bun`, variant `standard`, `min_windows_build: 17763`) |
| worker runtime (transport default) | 1.1.62, `qodercli-worker-runtime-win32-x64.tgz` 27.204.225 bytes | sha256 `c466805d…4bb1` cocok dengan sidecar `.sha256`; isi: `qoder-worker-runtime.obf.mjs` (obfuscated, 33 MB) + `vendor/ripgrep/x64-win32/rg.exe` (5,4 MB) + plugin `vendor/qoder-security` dengan skills/config sendiri |

Sumber unduhan (untuk regenerasi di mesin lain): `https://download.qoder.com/qodercli/releases/1.1.62/qodercli-windows-x64.zip`, `https://download.qoder.com/qodercli/releases/1.1.62/qodercli-worker-runtime-win32-x64.tgz` (+ sidecar `.sha256` di URL yang sama), manifest `https://download.qoder.com/qodercli/channels/1.1.62/manifest.json`. Jalankan ulang: `QODER_SPIKE_PKG_DIR=<dir artefak> node verify-artifacts.mjs`.

**Caveat integritas**: setiap pemeriksaan di rantai ini same-origin. `manifest.json`, artefak, dan sidecar `.sha256` semuanya berasal dari `download.qoder.com` / `qoder-ide.oss-accelerate.aliyuncs.com`, dan `QODER_CLI_MIRROR` bisa mengarahkan ulang keduanya. Tidak ada digest yang dipin di dalam paket SDK. "sha256 cocok manifest" membuktikan konsistensi transport, bukan provenance; CDN yang compromised mengalahkan semua pemeriksaan. Mitigasi yang mungkin: pin digest di repo ini (tabel di atas) dan bandingkan saat upgrade.

- **Lisensi & provenance**: top-level `LICENSE` proprietary — `SEE LICENSE IN LICENSE` → "Qoder Product Service Terms" (https://qoder.com/product-service); instalasi = persetujuan terms. TAPI 14 file deklarasi membawa header "Copyright 2026 Google LLC / SPDX-License-Identifier: Apache-2.0" (`dist/protocol/*.d.ts` — index, messages, control, permissions, hooks, mcp, launch, common, agents, version, model-prompt-patches, skill-evolution, memory, feedback — plus `core/security-scan-options.d.ts`, `core/usage-normalize.d.ts`, `daemon/protocol.d.ts`), dan `protocol/index.d.ts:11-13` menyebut skema zod sisi CLI hidup di `@google/gemini-cli-core`. Artinya paket ini turunan Gemini CLI (Apache-2.0) yang dipublikasikan ulang di bawah terms proprietary Qoder. Catat sebagai risiko provenance/rantai pasok dengan file-file tersebut sebagai bukti; keputusan hukum tetap di pemilik akun.
- **Peer dependency**: `zod ^3.25.0 || ^4.0.0` — repo sudah memakai zod 4.1.12, tidak ada dependency baru.
- **Dependency runtime**: hanya `@modelcontextprotocol/sdk ^1.27.1`.
- **postinstall**: `node scripts/postinstall.cjs` mengunduh worker runtime (delivery default; `runtime-manifest.json`: `defaultTransport: "worker"`, `packaged: false`, `delivery: "install"` — jadi install dengan `--ignore-scripts` tidak meninggalkan runtime apa pun; tidak relevan setelah transport disuntikkan, tetapi itu biaya install sebenarnya). Verifikasi sha256: manifest tidak memuat digest worker runtime, jadi script jatuh ke sidecar `.sha256` same-origin (lihat caveat). Bisa dilewati dengan `QODER_SKIP_DOWNLOAD=1` — fixture di spike ini berjalan tanpa binary apa pun.
- **Platform**: `windows-x64` dan `windows-arm64` didukung eksplisit (`SUPPORTED_CLI_PLATFORM_TARGETS`).
- **Autentikasi** (dari deklarasi `dist/auth.d.ts` + fixture A): `accessToken()`, `accessTokenFromEnv()` (`QODER_PERSONAL_ACCESS_TOKEN`), `serviceAccount()`, `serviceAccountFromEnv()` (`QODER_SERVICE_ACCOUNT_KEY`), `qodercliAuth()`. Token tidak pernah muncul di argv; ia ditulis ke payload file di mkdtemp khusus (`qoder-sdk-auth-`, intent mode 0600 di bundle — enforcement POSIX tidak terverifikasi di NTFS, lihat fixture A) yang **dihapus saat close** (diassert). Strategi produk: PAT/Service Account hanya di environment backend; browser tidak pernah menerima atau menampilkan kredensial. **Belum diverifikasi**: panggilan live dengan PAT asli (butuh persetujuan eksplisit + batas kredit).
- **Mode permission berbahaya ada di API**: `PermissionMode` mencakup `'bypassPermissions' | 'yolo'`, dan `allowDangerouslySkipPermissions` tersedia. Rencana migrasi menyatakan mode yang melewati approval bertentangan dengan batas repo. Adapter fase 1 harus pin mode aman, tidak pernah menyetel opsi bypass, dan fail-closed via `canUseTool` (fixture D membuktikan kedua sisi: deny terkirim, tanpa callback → error, bukan allow).

## Seam transport: PUTUSAN

`options.transport` menerima `QueryTransportProvider` publik dan **terdokumentasi**: `README.md:87-90` — "`query()` is the only query entry point and defaults to Worker. Pass `transport: ProcessTransport.default`, `transport: WorkerTransport.default`, or a custom transport provider when a single call needs to override the package default." Deklarasi: `dist/core/transport.d.ts` (diekspor dari index), guard runtime hanya `typeof create === 'function'`. **Transport bisa disuntikkan ke tes tanpa proses live dan tanpa emulator JSONL penuh.** `./protocol` types-only (runtime hanya `WIRE_PROTOCOL_VERSION = "1.5.0"`), jadi bukan itu seam-nya.

Dua seam yang dipakai spike, keduanya memanggil `query()` sungguhan:

1. **`options.spawnQoderCLIProcess`** (fixture A): menangkap argv/env yang dibangun `RuntimeLaunchOptionsBuilder.buildArgs()` sungguhan tanpa men-spawn binary. Bukti: `tools: []` → `--tools ""`, `disallowedTools` → 4× `--disallowed-tools`, `persistSession:false` → `--no-session-persistence`, tanpa flag bypass, `pathToQoderCLIExecutable` palsu → command yang di-spawn terbukti fake (hermetic).
2. **Custom `Transport`** (fixture B–H): mengendalikan kedua sisi JSONL control protocol (initialize handshake, `mcp_message`, `can_use_tool`, interrupt, timeout) dengan frame sintetis.

**Batas yang terdokumentasi**: `README.md:454-456` — "Session storage cannot be combined with `persistSession: false`, file checkpointing, custom transports, or the Cloud Agent runtime." Konsekuensi: strategi fake-transport **tidak bisa** menutup perilaku session-store/resume, yang relevan untuk sesi interview pooled di rencana fase 2. Perilaku itu butuh uji live atau desain ulang (resume per turn).

**Fakta boundary yang penting untuk tes fase 1**: pembatasan tool TIDAK muncul di `initialize` control request (isinya hanya `sdkMcpServers` + capability flags). `tools`/`disallowedTools`/`permissionMode` naik lewat launch options → argv (ProcessTransport). Dengan custom transport, batasan teramati di `create(options)` (`ProcessTransportOptions`); dengan ProcessTransport, teramati sebagai argv. Assert di seam yang sama pada adapter nanti.

**Semantik flag yang didokumentasikan README**: `README.md:243-246` — "`allowedTools` is an approval allowlist: listed tools are auto-approved… It does not remove tools from the agent's available toolset. To block tools, use `disallowedTools`." Ini mengonfirmasi asumsi rencana §1 dan memaku desain adapter. **Gap**: `tools: []` menjadi `--tools ""` (`s.join(",")` di bundle), dan tidak ada dokumentasi apa arti nilai kosong bagi qodercli (no-tools vs fallback ke default) — **belum terverifikasi**. Karena itu boundary produk tidak boleh bersandar pada satu flag tak terdokumentasi: pertahankan **defense-in-depth** — `tools: []` DAN `disallowedTools: ["Bash","Read","Write","Edit"]` DAN `canUseTool` fail-closed.

Konsekuensi untuk strategi tes fase 1:

1. **Tes adapter** (translasi `SDKMessage` → event internal): fake `Transport` + frame sintetis, seperti `spike.test.mjs` di direktori ini. Menutup delta, result, error, cancel, timeout, permission, MCP.
2. **Tes domain** (budget, provenance, `finishSearch`): tetap fake session di batas aplikasi (pola `PiSessionLike` yang sudah ada). Tidak ditulis ulang.
3. Dua fixture `fauxProvider` Pi (`tests/agent-search.test.ts`, `tests/evals/trajectory.eval.ts`) perlu padanan Qoder: fake transport yang **mengeksekusi tool domain sungguhan** melalui jalur MCP in-process (fixture C membuktikan mekanismenya), bukan canned text.

## Bukti fixture offline (8/8 lulus, tanpa jaringan)

`node --test spike.test.mjs` — keluaran tersimpan di `fixtures-output.txt`.

| Fixture | Klaim yang dibuktikan |
| --- | --- |
| A | `spawnQoderCLIProcess` menangkap launch args tanpa men-spawn binary nyata (command = path palsu yang diassert): `tools: []` → `--tools ""`; `disallowedTools` → 4× `--disallowed-tools`; `persistSession:false` → `--no-session-persistence`; tidak ada `--dangerously-skip-permissions`; token tidak ada di argv; auth payload ditulis ke mkdtemp khusus (`qoder-sdk-auth-`) dan **dihapus saat close**. Mode 0600 = intent (terbukti dari `writeFile {mode:0o600}`+`chmod` di bundle); enforcement POSIX hanya diassert di non-Windows karena NTFS tidak mengekspos mode bits (statSync selalu 0o666) — di Windows fixture assert file nyata + dir mkdtemp khusus |
| B | `tools`/`disallowedTools`/`settingSources` sampai utuh ke transport launch options; `allowedTools` tidak diset (bukan default permisif); `initialize` request tidak memuat batasan tool (boundary fact di atas) |
| C | `createSdkMcpServer` + `tool()`: `tools/list` lewat control channel mengembalikan **hanya** tool terdaftar; `tools/call` mengeksekusi handler in-process dengan argumen tervalidasi zod dan hasilnya kembali lewat control channel; argumen invalid ditolak sebelum handler; tool tak terdaftar (`Bash`) ditolak; server name asing → error; instance server tidak pernah menyeberang wire (`createOptions.mcpServers` undefined) |
| D | `canUseTool` deny sampai sebagai `behavior: "deny"`; **tanpa callback, SDK membalas error control request (fail-closed), bukan allow** |
| E | Mapping `SDKMessage`: `system/init` (termasuk `tools: []` dan `protocol_version`), `stream_event` delta teks 1:1, `assistant.message.usage`, `result.result` sebagai teks final, `usage.credits`/`total_credits` terpisah dari `total_cost_usd` (kolom biaya USD lama harus tetap `null`) |
| F | `result` subtype `error_during_execution` muncul sebagai pesan dengan `is_error:true` + `errors[]`, iterator tidak melempar |
| G | `interrupt()` → control request `interrupt` + response `still_queued`; `AbortController.abort()` → transport ditutup, iterasi berakhir bersih **tanpa AbortError ke consumer**; control request pasca-abort reject (generic "Transport closed"), tidak hang. Konsekuensi adapter: **state cancel harus dilacak host-side** (flag sendiri) karena tidak ada sinyal terminal bertipe yang muncul ke consumer |
| H | `controlRequestTimeoutMs` → SDK mengirim `control_cancel_request` dan request reject; `getUsageInfo()` menelan error menjadi `null` — adapter tidak boleh membaca `null` sebagai "0 kredit" |

## Batas bukti / belum terverifikasi

Fixture membuktikan sisi SDK: opsi yang dikirim, handshake, routing MCP in-process, permission fail-closed, mapping pesan. Yang **hanya bisa dibuktikan runtime live** (ditandai `belum terverifikasi` sesuai issue):

- **Enforcement sisi CLI**: apakah qodercli 1.1.62 sungguhan menampilkan `tools: []` di `system/init`, menolak `Bash` saat runtime, dan bagaimana CLI memaknai `--tools ""` (no-tools vs fallback default).
- **Autentikasi PAT/Service Account live** (gate issue #24: persetujuan eksplisit + batas kredit).
- **Cancel saat model/tool benar-benar berjalan** dan **accounting usage/kredit nyata** dari server Qoder.
- **Konkurensi handler `tool()`**: Pi punya `executionMode: "sequential"`; deklarasi Qoder tidak menunjukkan padanannya. Handler yang memutasi `AgentSearchState` harus dianggap bisa dipanggil serentak dan diserialkan sendiri di fase 1.
- **Session-store/resume**: tidak bisa diuji via custom transport (batas README di atas); relevan untuk interview pooled fase 2.
- **Worker transport** adalah default; runtime-nya `.mjs` terobfuscasi 33 MB. Untuk server produksi, ProcessTransport (binary `qodercli.exe`) lebih mudah diaudit; keputusan transport final = fase 1.

## Risiko untuk keputusan go/no-go

1. **Privasi**: `qodercli` mengirim konteks tugas (prompt, potongan CV/posting yang masuk konteks) ke layanan inferensi Qoder. Klaim "data tetap lokal" tidak lagi berlaku. Loopback-only UI tidak berubah, tetapi boundary data bergeser ke vendor. Sisi positif yang terbukti: token tidak pernah lewat argv; payload auth ditulis ke mkdtemp khusus dan dihapus saat close (fixture A). Mode 0600 adalah intent yang terbukti di bundle, bukan sesuatu yang bisa diverifikasi enforcement-nya di NTFS.
2. **Biaya**: kredit Qoder ≠ USD. `total_cost_usd` dari SDK tidak dapat dipercaya sebagai biaya nyata (fixture E: 0 sementara credits 12). Kolom `estimatedCost` lama tetap `null`; metering kredit butuh unit terpisah. Biaya kredit per tugas belum terukur — butuh live run berpasangan dengan cap.
3. **Lisensi & rantai pasok**: ToS proprietary (bukan OSS) untuk repo yang saat ini pin dependency MIT-ish; turunan Gemini CLI Apache-2.0 yang dipublikasikan ulang; postinstall mengunduh ~125 MB dari CDN Alibaba OSS dengan integrity same-origin saja; worker runtime obfuscated + bundled `rg.exe` + plugin `qoder-security`. Pin versi SDK + CLI dan simpan digest di repo (lever `verify-artifacts.mjs`).
4. **Tidak ada perubahan gerbang approval**: spike tidak menyentuh `src/`; approval manual, provenance, dan validator tetap di kode aplikasi. Mode `bypassPermissions`/`yolo`/`allowDangerouslySkipPermissions` tidak pernah disentuh dan harus tetap dilarang di adapter.

## Pemilihan model: katalog Qoder vs custom model (BYOK)

**Keputusan pemilik (2026-09-24)**: (1) pengiriman konteks ke layanan Qoder diterima ("aman aja datanya ke sana"); (2) provider Pi lama (`google`, `openai-codex` di `defaultSettings` config.ts:238) TIDAK dipetakan ke Qoder — fase 1 memakai **custom model yang sudah disimpan pemilik di qoder-cli**, dipilih lewat mekanisme 1 di bawah. `selectConfiguredModel` (pi.ts:67) menerima `(provider, model)` dari Pi ModelRuntime; padanan Qoder-nya `options.model: "<value>"` dari katalog akun — Settings UI fase 1 cukup menyimpan `value` tunggal, bukan pasangan provider/model. Konteks dari pemilik: model custom-nya Qwen-3.8-Max via Alibaba Cloud Model Studio (Singapore), paket Pro Trial dengan ~294 kredit tersedia — usulan cap 10 kredit untuk probe enforce nyaman di dalam saldo itu; `value` katalog pastinya menunggu probe (`getAvailableModels`).

Ada **tiga mekanisme terpisah** di SDK 1.0.49 (docs.qoder.com/cli/sdk/model-policy + deklarasi paket):

1. **`options.model` (fixed/push mode)** — string identifier; CLI meresolusi lewat rantai lokal (options → settings → model router). **Ini jalur untuk custom model yang disimpan di qoder-cli**: host tidak pernah menyentuh API key (kredensial tetap di config CLI); cukup pass `value` katalognya. Runtime: `Query.setModel()` bisa mengganti model fixed-mode; `getAvailableModels({ fetchStrategy: 'live' })` → `ModelInfo[]` dengan `source: 'system' | 'user' | 'organization' | 'custom'` untuk enumerasi. Bila diomit, default akun yang dipakai.
2. **`resolveModel` (dynamic/pull mode)** — callback dipanggil sebelum **setiap** LLM call (`get_model_policy`); mengembalikan id platform ATAU objek `CustomModel` inline (`{ provider, api_key, model?, url?, style?, isVl? }` — `protocol/control.d.ts:730`) untuk **BYOK yang disuplai host** dengan kredensial per-call di wire. Kedua mode mutually exclusive — passing callback membuat `options.model` diabaikan. Tidak ada automatic fallback: callback yang timeout/throw/empty membuat query FAIL (docs + deklarasi). **Tidak dibutuhkan untuk kasus sekarang**; relevan nanti hanya untuk routing per-purpose (tier hemat parsing vs tier kuat penalaran).
3. **BYOK config CRUD via `Query`** — `listByokConfigs()` (capability-gated `BYOK_CONFIG_MANAGEMENT_CAPABILITY`; deklarasi: "secret-free ... returned by the CLI"), `validateByokModel()`, dst. Untuk memverifikasi config yang tersimpan tanpa membaca file config CLI.

**Routing inferensi custom model — dua kemungkinan, menentukan cerita privasi/biaya**: custom model yang disimpan via qoder-cli/BYOK bisa (a) diproksikan lewat Qoder (kredit Qoder terpakai, Qoder melihat prompt) atau (b) direct ke endpoint provider (`url`/`outerProvider` di `CustomModel`; byok.d.ts:6-7 menyebut "route a single LLM call through a third-party provider"). README tidak punya bagian BYOK; docs model-policy tidak menyatakan routing-nya. **Belum terverifikasi**, tapi docs cost-usage memberi instrumen pastinya: per-request `usage.credits` / `usage.original_credits` / **`usage.billable`** ("Whether the request counts toward the user's Credits usage") di assistant message, plus `result.total_credits` dan `result.modelUsage[model].credits` per model. Probe enforce sekarang mencetak ketiganya; `billable: false` + kredit 0 = direct, `billable: true` = proxied lewat Qoder. Catatan docs lain yang mengikat adapter fase 1: field kredit opsional (CLI lama) — **jangan baca yang hilang sebagai 0**; `total_credits` kumulatif sesi, jangan dijumlah antar-result.

**Status bukti**: mekanisme 1-3 ada di deklarasi terpasang + docs; **pemanggilan live belum diverifikasi** (gate issue #24). Batas yang dipertahankan: TIDAK membaca `~/.qoder`/config CLI untuk menemukan model id (API key BYOK mungkin tersimpan di sana; AGENTS.md melarang) — enumerasi hanya lewat `getAvailableModels`/`listByokConfigs` di dalam sesi yang diautentikasi pemilik.

**Konsekuensi produk fase 1**: bila custom model = provider eksternal dan routing-nya direct, prompt terkirim ke provider itu, bukan (hanya) ke Qoder — pemilik sudah menerima pengiriman data, tetapi Settings UI fase 1 harus tetap menampilkan provider tujuan inferensi secara eksplisit. Kredensial BYOK tetap tidak boleh menyentuh browser.

## Live probe yang dimintakan persetujuan (belum dijalankan)

`live-probe.mjs` menolak berjalan tanpa `QODER_SPIKE_LIVE=1` + auth + runtime. Auth: `QODER_SPIKE_AUTH=cli` memakai ulang login `qodercli` lokal secara read-only (`qodercliAuth()` — tanpa ekspor token, kredensial tidak pernah masuk env/transcript), atau `QODER_PERSONAL_ACCESS_TOKEN` untuk PAT.

**Prasyarat runtime** (probe fail-fast bila tidak dipenuhi): spike di-install dengan `QODER_SKIP_DOWNLOAD=1`, jadi `dist/_worker` dan `dist/_bundled` tidak ada; tanpa override, SDK memilih transport default `worker` dan mati saat resolusi runtime. Dua jalan: `QODERCLI_PATH=<path qodercli.exe>` (memaksa ProcessTransport memakai CLI lokal — di mesin ini `where qodercli` → `C:\Users\chand\.qoder\bin\qodercli\qodercli.exe`), atau `npm install` penuh sekali di direktori spike (mengunduh worker runtime 27 MB dengan cek sha256). Jalan QODERCLI_PATH paling mulus karena custom model pemilik memang tersimpan di CLI lokal itu.

Dua mode:

1. **Default (katalog, kemungkinan besar NOL kredit)**: handshake initialize + `getAvailableModels` + `listByokConfigs` + dump `system/init` (model, tools). Tidak ada prompt yang dikirim, tidak ada inferensi — hanya control requests (biaya kredit diharapkan 0; tetap digate karena menyentuh akun live). Menjawab: `value` custom model pemilik, `source`-nya, dan apakah `QODER_SPIKE_MODEL=<value>` diterima sebagai `system/init.model`.
2. **`QODER_SPIKE_ENFORCE=1` (1 panggilan inferensi)**: satu turn adversarial sintetis (`maxTurns: 1`): `system/init.tools` harus kosong, permintaan `Bash` harus ditolak; probe mencetak `usage.credits`/`original_credits`/`billable` per request + `result.total_credits` + `modelUsage` untuk menjawab routing (proxied vs direct). **Usulan cap: 10 kredit, butuh persetujuan pemilik**; probe FAIL bila terlampaui.

Output probe sudah diredaksi di dalam script (bukan di langkah paste): akun hanya `{apiProvider, subscriptionType, tokenSource}`; BYOK lewat allowlist field (`key`, `providerId`, `provider`, `model`, `defaultModelId`, `displayName`) dengan fallback nama-key saja untuk shape tak dikenal.

```
cd spike/qoder-sdk
set QODERCLI_PATH=C:\Users\chand\.qoder\bin\qodercli\qodercli.exe
QODER_SPIKE_LIVE=1 QODER_SPIKE_AUTH=cli QODERCLI_PATH=... node live-probe.mjs                              # katalog saja
QODER_SPIKE_LIVE=1 QODER_SPIKE_AUTH=cli QODERCLI_PATH=... QODER_SPIKE_ENFORCE=1 node live-probe.mjs        # + enforcement, usulan cap 10 kredit
QODER_SPIKE_LIVE=1 QODER_SPIKE_AUTH=cli QODERCLI_PATH=... QODER_SPIKE_MODEL=<value> node live-probe.mjs    # pin custom model
```

## Menjalankan ulang spike

```
cd spike/qoder-sdk
QODER_SKIP_DOWNLOAD=1 npm ci      # lockfile ter-commit; skip-download mencegah postinstall fetch binary
npm test                          # 8 fixture offline
QODER_SPIKE_PKG_DIR=<dir> npm run verify-artifacts   # digest artefak (unduh dulu dari URL di atas)
```

Direktori spike ini sengaja di luar glob `tsconfig.json` (`src/`, `tests/`, `scripts/`), `npm test` root (`tests/*.test.ts`), dan `harness:check` (markdown roots + `src/server`/`src/tracker`), sehingga tidak pernah masuk suite proyek dan tidak menyentuh dependency root.
