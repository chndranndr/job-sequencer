# Issue #24 — Qoder Agent SDK fase 0: hasil spike

Status: **GO bersyarat** untuk fase 1. Semua klaim di bawah berasal dari fixture offline dan deklarasi paket terpasang; tidak ada panggilan provider live, tidak ada binary qodercli yang dieksekusi, tidak ada kredensial yang dibaca atau dikirim.

## Artefak yang diperiksa (statis)

| Artefak | Versi | Bukti |
| --- | --- | --- |
| `@qoder-ai/qoder-agent-sdk` | 1.0.49 (latest, dipublikasi 2026-09-23) | tarball npm sha512 `wtNfj0zM…ZLw==` cocok dengan `dist.integrity` registry |
| `qodercli` (binary proses) | 1.1.62, `qodercli-windows-x64.zip` 97.778.572 bytes | sha256 `15978912…e5b5` cocok dengan `channels/1.1.62/manifest.json` (runtime `bun`, variant `standard`, `min_windows_build: 17763`) |
| worker runtime (transport default) | 1.1.62, `qodercli-worker-runtime-win32-x64.tgz` 27.204.225 bytes | sha256 `c466805d…4bb1` cocok dengan sidecar `.sha256`; isi: `qoder-worker-runtime.obf.mjs` (obfuscated, 33 MB) + `vendor/ripgrep/x64-win32/rg.exe` |

Jalankan ulang: `node verify-artifacts.mjs` (butuh artefak di `QODER_SPIKE_PKG_DIR`, default `H:/work/qoder-sdk-spike/pkg`).

- **Lisensi**: BUKAN open source. `SEE LICENSE IN LICENSE` → "Qoder Product Service Terms" (https://qoder.com/product-service). Instalasi = persetujuan terms. Ini keputusan hukum pemilik akun, bukan keputusan teknis.
- **Peer dependency**: `zod ^3.25.0 || ^4.0.0` — repo sudah memakai zod 4.1.12, tidak ada dependency baru.
- **Dependency runtime**: hanya `@modelcontextprotocol/sdk ^1.27.1`.
- **postinstall**: `node scripts/postinstall.cjs` mengunduh worker runtime dari `download.qoder.com` dengan verifikasi sha256 (sidecar `.sha256`; manifest tidak memuat digest worker runtime, hanya digest CLI zip). Bisa dilewati dengan `QODER_SKIP_DOWNLOAD=1` — fixture di spike ini berjalan tanpa binary apa pun.
- **Platform**: `windows-x64` dan `windows-arm64` didukung eksplisit (`SUPPORTED_CLI_PLATFORM_TARGETS`).
- **Autentikasi** (dari deklarasi `dist/auth.d.ts` + bundle): `accessToken()`, `accessTokenFromEnv()` (`QODER_PERSONAL_ACCESS_TOKEN`), `serviceAccount()`, `serviceAccountFromEnv()` (`QODER_SERVICE_ACCOUNT_KEY`), `qodercliAuth()`. Token ditulis ke temp file 0600 (`QODER_SDK_AUTH_PAYLOAD_FILE`) dan dibersihkan setelah launch; **tidak pernah muncul di argv** (dibuktikan fixture A). Strategi produk: PAT/Service Account hanya di environment backend; browser tidak pernah menerima atau menampilkan kredensial. **Belum diverifikasi**: panggilan live dengan PAT asli (butuh persetujuan eksplisit + batas kredit).

## Seam transport: PUTUSAN

`options.transport` menerima `QueryTransportProvider` publik (`dist/core/transport.d.ts`, diekspor dari index). `query()` memanggil `provider.create(options)` per sesi; guard-nya hanya `typeof create === 'function'`. Ini seam stabil yang terdokumentasi — **transport bisa disuntikkan ke tes tanpa proses live dan tanpa emulator JSONL penuh**. `./protocol` sendiri types-only (runtime hanya `WIRE_PROTOCOL_VERSION = "1.5.0"`), jadi bukan itu seam-nya; seam-nya `options.transport`.

Konsekuensi untuk strategi tes fase 1:

1. **Tes adapter** (translasi `SDKMessage` → event internal): fake `Transport` + frame sintetis, seperti `spike.test.mjs` di direktori ini. Menutup delta, result, error, cancel, timeout, permission, MCP.
2. **Tes domain** (budget, provenance, `finishSearch`): tetap fake session di batas aplikasi (pola `PiSessionLike` yang sudah ada). Tidak ditulis ulang.
3. Dua fixture `fauxProvider` Pi (`tests/agent-search.test.ts`, `tests/evals/trajectory.eval.ts`) perlu padanan Qoder: fake transport yang **mengeksekusi tool domain sungguhan** melalui jalur MCP in-process (fixture C membuktikan mekanismenya), bukan canned text.

## Bukti fixture offline (8/8 lulus, tanpa jaringan)

`node --test spike.test.mjs` — keluaran tersimpan di `fixtures-output.txt`.

| Fixture | Klaim yang dibuktikan |
| --- | --- |
| A | `spawnQoderCLIProcess` menangkap launch args tanpa men-spawn binary: `tools: []` → `--tools ""`; `disallowedTools` → 4× `--disallowed-tools`; `persistSession:false` → `--no-session-persistence`; tidak ada `--dangerously-skip-permissions`; token tidak ada di argv, hanya path payload file di env |
| B | `tools`/`disallowedTools`/`settingSources` sampai utuh ke transport launch options; `allowedTools` tidak diset (bukan default permisif) |
| C | `createSdkMcpServer` + `tool()`: `tools/list` lewat control channel mengembalikan **hanya** tool terdaftar; `tools/call` mengeksekusi handler in-process dengan argumen tervalidasi zod; argumen invalid ditolak sebelum handler; tool tak terdaftar (`Bash`) ditolak; server name asing → error |
| D | `canUseTool` deny sampai sebagai `behavior: "deny"`; **tanpa callback, SDK membalas error control request (fail-closed), bukan allow** |
| E | Mapping `SDKMessage`: `system/init` (termasuk `tools: []` dan `protocol_version`), `stream_event` delta teks 1:1, `assistant.message.usage`, `result.result` sebagai teks final, `usage.credits`/`total_credits` terpisah dari `total_cost_usd` (kolom biaya USD lama harus tetap `null`) |
| F | `result` subtype `error_during_execution` muncul sebagai pesan dengan `is_error:true` + `errors[]`, iterator tidak melempar |
| G | `interrupt()` → control request `interrupt` + response `still_queued`; `AbortController.abort()` → transport ditutup, iterasi berakhir bersih (tanpa throw ke consumer); control request pasca-abort reject, tidak hang |
| H | `controlRequestTimeoutMs` → SDK mengirim `control_cancel_request` dan promise reject `CONTROL_REQUEST_TIMEOUT`; catatan: `getUsageInfo()` menelan error menjadi `null` — adapter tidak boleh membaca `null` sebagai "0 kredit" |

## Batas bukti / belum terverifikasi

- **Enforcement sisi CLI**: fixture membuktikan SDK *mengirim* batas yang benar dan MCP in-process hanya mengekspos tool terdaftar. Apakah qodercli 1.1.62 sungguhan menampilkan `tools: []` di `system/init` dan menolak `Bash` saat runtime — **belum terverifikasi**, butuh satu panggilan live yang disetujui (perintah persetujuan ada di bawah).
- **Autentikasi PAT live**: belum diverifikasi (gate issue #24).
- **Konkurensi handler `tool()`**: Pi punya `executionMode: "sequential"`; deklarasi Qoder tidak menunjukkan padanannya. Handler yang memutasi `AgentSearchState` harus dianggap bisa dipanggil serentak dan diserialkan sendiri di fase 1.
- **Worker transport** adalah default (`runtime-manifest.json`). Worker runtime berupa `.mjs` terobfuscasi 33 MB. Untuk server produksi, ProcessTransport (binary `qodercli.exe`) lebih mudah diaudit; keputusan transport final = fase 1.

## Risiko untuk keputusan go/no-go

1. **Privasi**: `qodercli` mengirim konteks tugas (prompt, potongan CV/posting yang masuk konteks) ke layanan inferensi Qoder. Klaim "data tetap lokal" tidak lagi berlaku. Loopback-only UI tidak berubah, tetapi boundary data bergeser ke vendor.
2. **Biaya**: kredit Qoder ≠ USD. `total_cost_usd` dari SDK tidak dapat dipercaya sebagai biaya nyata (fixture E: 0 sementara credits 12). Kolom `estimatedCost` lama tetap `null`; metering kredit butuh unit terpisah.
3. **Lisensi & rantai pasok**: terms proprietary + postinstall mengunduh binary ~125 MB dari CDN Alibaba OSS dengan verifikasi sha256 sidecar. Pin versi SDK + CLI dan simpan digest (lever `verify-artifacts.mjs`).
4. **Tidak ada perubahan gerbang approval**: spike tidak menyentuh `src/`; approval manual, provenance, dan validator tetap di kode aplikasi.

## Perintah untuk satu live-run yang disetujui (fase berikutnya, bukan sekarang)

```
# hanya setelah pemilik akun menyetujui + batas kredit disepakati:
QODER_PERSONAL_ACCESS_TOKEN=<token> node live-probe.mjs   # belum dibuat; satu query sintetis, tools:[], assert system/init.tools kosong
```

## Menjalankan ulang spike

```
cd spike/qoder-sdk
QODER_SKIP_DOWNLOAD=1 npm install
npm test                 # 8 fixture offline
npm run verify-artifacts # digest artefak (butuh artefak terunduh di scratch)
```
