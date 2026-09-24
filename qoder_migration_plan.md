# Rencana migrasi backend agent ke Qoder

Status: rencana, belum ada perubahan runtime. Fakta kapabilitas Qoder di sini berasal dari dokumentasi dan metadata paket, bukan uji live dengan akun pengguna. Dokumen ini membandingkan dua cara memakai model Qoder, lalu merinci migrasi ke **Qoder Agent SDK**. Seluruh pemeriksaan awal harus memakai fixture sintetis. Jangan menjalankan provider, scraper, atau mengirim profil pribadi tanpa persetujuan eksplisit.

## Keputusan yang direkomendasikan

Buat branch `feat/qoder-agent-sdk` dari kondisi kerja yang memang ingin dijadikan dasar. Migrasikan runtime agent di branch itu; jangan menyebut integrasi provider Pi sebagai migrasi SDK. Pertahankan gerbang persetujuan, batas tool, dan evaluasi deterministik sebelum mencoba fitur agent baru. Kode aplikasi tidak mengirim lamaran atau pesan secara otomatis.

| Jalur | Yang berubah | Kegunaan | Batas dan keputusan |
| --- | --- | --- | --- |
| A. `pi-provider-qoder` | Tambah provider model Qoder ke Pi; `pi-coding-agent` tetap menjadi runtime. | Eksperimen kualitas model dengan perubahan kecil, **bukan** pemenuhan syarat SDK. | Ekstensi pihak ketiga dari satu maintainer, bukan produk Qoder. Paket 0.4.5 membangun terhadap Pi `^0.85.1`, sedangkan repo memakai 0.84.1. Deskripsi paket menyebut \"COSY signatures and WAF bypass\"; telaah aturan layanan, rantai pasok, dan penanganan kredensial sebelum memakainya. Sesi produksi memuat resource dengan `noExtensions: true` (`src/server/pi.ts:620-632`), sehingga pemasangan ekstensi saja belum membuktikan backend ini bisa memakainya. Jangan buka seluruh ekstensi hanya agar provider ini bekerja. |
| B. `@qoder-ai/qoder-agent-sdk` | Ganti loop Pi dengan `query()` dan proses `qodercli`; port tool ke MCP in-process. | Jalur yang memenuhi migrasi SDK. | Model dan akun Qoder menggantikan pilihan provider Pi. Perlu port sesi, event, tool, tes deterministik, dan Settings. Ini pilihan utama **hanya setelah** spike membuktikan batas keamanan dan kemampuan test-nya. |

Estimasi kasar untuk satu engineer yang mengenal repo: spike B 1-2 hari kerja; migrasi fungsional pencarian dan generasi 1-2 minggu; paritas semua alur berikut interview, TRACE, tes, dan hardening sekitar 2-4 minggu total. Jalur A mungkin 1-3 hari jika versi dan registrasi provider cocok; bisa lebih lama atau ditolak jika mengharuskan mengaktifkan ekstensi yang sekarang sengaja dimatikan. Ini estimasi pekerjaan, bukan janji kualitas model atau harga kredit.

**Definisi paritas:** input dan persetujuan manusia tetap sama, job hanya berasal dari tool yang diizinkan, batas pencarian berlaku, keluaran melewati validator yang sama, serta cancel dan timeout tetap bekerja. Teks, urutan token, granularitas TRACE, biaya, dan hasil sampling tidak akan identik antara model.

## Peta implementasi saat ini

- `src/server/pi.ts:20-29,256-513,581-644` memiliki kontrak sesi, watchdog durasi dan aktivitas, pembatalan, redaksi TRACE, accounting, dan pabrik sesi tanpa tool atau dengan tool terbatas. Empat belas pemanggil `runBoundedPi` memakai kontrak ini; pertahankan bentuk perilakunya melalui satu adapter, bukan port tiap pemanggil secara terpisah.
- `src/server/search/tools.ts:245-332` memiliki empat tool adaptive search dan state anggaran, provenance, serta `finishSearch`. `src/server/scrape.ts:168-230` memiliki tool per sumber; `src/server/research-tools.ts:14-27` memiliki satu tool riset. Definisi tool sekarang memakai Pi `defineTool` dan TypeBox; Zod sudah ada sebagai dependency dan dipakai dalam validasi domain.
- `src/server/runs.ts:535-567,683-733` menolak hasil tanpa `finishSearch`, memeriksa provenance, dan memvalidasi hasil sebelum persist. `src/server/structured.ts:180-221` menerima fungsi `execute(prompt): Promise<string>`, lalu mengerjakan parse JSON, validasi schema dan bisnis, serta retry sendiri. Qoder **tidak perlu** menyediakan mode structured output agar kontrak ini tetap bekerja.
- `src/server/interview-sessions.ts:11-22,148-175,287-355` memakai ulang sesi per job sampai 15 menit, maksimum delapan, dengan prompt lanjutan pada sesi yang sama. `src/server/coordinator.ts:100-125` menentukan status dan menjumlahkan pemakaian. `src/trajectory.ts:48-83` serta `tests/trajectory.test.ts:467-489` bergantung pada jenis event internal yang sekarang bernama seperti event Pi.
- `src/server/config.ts:99-101`, `src/server/app.ts:361-364`, dan `src/tracker/disk.tsx:532-547` menyimpan dan menampilkan provider/model Pi. `src/server/db.ts:422-446` tetap menjadi pemilik gerbang approval dan pencatatan Applied. Jangan pindahkan keputusan itu ke agent atau prompt.
- Sebagian besar tes workflow menyuntikkan objek yang memenuhi `PiSessionLike`, bukan menjalankan SDK. Tes yang benar-benar memakai `fauxProvider` Pi ada di `tests/agent-search.test.ts:729-732` dan `tests/evals/trajectory.eval.ts:526-569`; `tests/pi-sdk-contract.test.ts:1-64` mengunci deklarasi Pi. Pertahankan kemampuan injeksi sesi agar tes domain tidak harus ditulis ulang. Hapus nama dan kontrak Pi yang tidak berlaku saat cutover, bukan sisakan alias lama.

## Rencana kerja di branch SDK

### 0. Tetapkan target dan buktikan kelayakan

1. Pastikan rubric meminta SDK lokal `@qoder-ai/qoder-agent-sdk`, bukan provider Qoder di Pi atau layanan **Qoder Cloud Agents CN**. Mode Cloud Agent dalam SDK masih eksperimental dan tidak mendukung MCP lokal; mode itu tidak cocok langsung untuk tool pencarian repo ini.
2. Pin versi SDK setelah meninjau `LICENSE`, dependensi, dan skrip instalasinya. Paket 1.0.49 menjalankan `postinstall`; proses runtime membawa binary `qodercli`. Jangan jalankan instalasi atau autentikasi sebagai bagian dari pembacaan rencana ini.
3. Pada branch, buat spike terisolasi: `tools: []` benar-benar mencegah tool bawaan; sesi MCP hanya melihat tool yang diberi izin; adapter membaca final `result`, delta teks, pemakaian, error, dan cancel. Buktikan di Windows dengan data sintetis. Uji autentikasi PAT atau Service Account hanya setelah pemilik akun mengizinkan panggilan live.
4. Strategi determinisme **belum terpecahkan**. Periksa deklarasi paket yang terpasang, termasuk entry point `./protocol`, untuk memastikan apakah transport dapat disuntikkan tanpa proses live. Jika tidak ada seam yang stabil, pertahankan fake sesi pada batas adapter dan uji translasi event secara terpisah; jangan membangun emulator protokol JSONL penuh hanya demi tes. Jadikan hasil pemeriksaan ini syarat lanjut ke fase 1.

Lulus fase ini bila demo JSON tanpa tool, demo satu tool terbatas, cancel saat tool berjalan, dan fixture tanpa jaringan dapat dibuktikan. Jika gagal, hentikan migrasi penuh dan catat hambatan spesifik.

### 1. Ganti runtime tanpa mengubah aturan produk

1. Ganti `createAgentSession` dengan `query()` di modul integrasi server. Pertahankan kontrak sesi yang dipakai pemanggil, tetapi beri nama netral pada tipe/fungsi dan migrasikan seluruh impor. Terjemahkan `SDKMessage` Qoder menjadi event internal `assistant_message`, `assistant_thinking`, `tool_execution_start/update/end`, dan status terminal yang dipakai TRACE. Jangan menganggap setiap `result` sukses; periksa subtype dan error.
2. Pindahkan timeout total, timeout inaktivitas, `AbortSignal`, dan cleanup proses ke adapter. Uji pembatalan saat model mengeluarkan teks dan saat handler tool masih aktif. Pertahankan redaksi sebelum event masuk SQLite atau tampil di browser. Token, kredit Qoder, dan `costUSD` tidak boleh dianggap satu unit; kolom biaya lama tetap `null` bila nilai uang tidak tersedia.
3. Sesi generasi, parsing profil, dan visual harus punya `tools: []`. Sesi riset dan pencarian hanya mendaftarkan MCP tool yang diperlukan. Mulai dengan `settingSources: []`, `skills: []`, tanpa plugins, `persistSession: false` untuk pekerjaan satu putaran, dan larang `Bash`, `Read`, `Edit`, `Write`, serta akses direktori tambahan yang tidak dibutuhkan. `allowedTools` bukan pembatas visibilitas; tetapkan `tools` secara eksplisit dan gunakan permission yang fail-closed.
4. Port tool ke `tool()` dan `createSdkMcpServer()`. Pertahankan validasi argumen, timeout sumber, anggaran, provenance, dan hasil domain di fungsi yang sama. Pi `executionMode: "sequential"` tidak punya padanan yang terlihat pada `tool()` Qoder: buktikan perilaku panggilan serentak dan serialkan handler yang memutasi `AgentSearchState` bila perlu. Pertahankan metadata hasil `details` bagi pemanggil internal seperti preflight dan tes; petakan hanya data yang perlu dilihat model ke format MCP yang didukung.

Lulus fase ini bila pencarian tidak bisa memanggil shell atau membaca file, urutan tool serentak tidak merusak budget dan `finishSearch`, serta hasil tanpa provenance tetap ditolak. TRACE harus menunjukkan aktivitas tanpa menampilkan CV, posting, prompt, atau rahasia.

### 2. Selesaikan alur yang punya state panjang

1. Untuk interview, pilih satu `query()` lokal dengan input `AsyncIterable<SDKUserMessage>` selama sesi pooled hidup. Batasi tetap delapan sesi dan TTL 15 menit, tutup proses pada eviksi atau kegagalan. Ini mempertahankan konteks multi-turn tanpa mengaktifkan persistensi transkrip ke disk. Jika proses idle ternyata mahal atau tidak stabil, ukur dulu sebelum mengganti desain dengan resume per turn; resume mengubah biaya, startup, dan jejak data.
2. Sesuaikan `/api/ai/models`, validasi Settings, dan UI DISK. Qoder adalah satu provider akun dengan pilihan model/tier yang tersedia untuk akun itu; jangan diam-diam mengartikan `google` atau `openai-codex` yang tersimpan sebagai Qoder. Tentukan migrasi eksplisit untuk Settings lama tanpa menyentuh data pribadi saat pengembangan.
3. Perbarui panduan operator di `README.md`, label produk, dan dependensi setelah cutover berhasil. Simpan PAT hanya di environment atau penyimpan rahasia backend; browser tidak menerima atau menampilkan kredensial.

Lulus fase ini bila interview mempertahankan konteks dua putaran, SSE tetap mengalir, cancel membuang sesi rusak, Settings lama tidak memilih model salah, dan approval tetap memerlukan verifikasi dokumen.

### 3. Pulihkan pembuktian deterministik

1. Pertahankan fake sesi buatan tes yang mengimplementasikan kontrak aplikasi. Port dua fixture yang memakai `fauxProvider` agar tetap mengeksekusi tool domain dan menghasilkan event yang setara tanpa provider live; canned teks saja tidak membuktikan budget/provenance.
2. Ganti `tests/pi-sdk-contract.test.ts` dengan pemeriksaan kontrak Qoder yang benar-benar relevan pada versi terpasang. Tambahkan uji adapter untuk subtype gagal, delta vs pesan final, cancel, tool terlarang, metadata usage yang hilang, dan pembatasan sesi.
3. Jalankan tes relevan, `npm run check`, `npm test`, `npm run eval`, dan `npm run smoke:browser` setelah integrasi. Panggilan provider live adalah tahap terpisah yang perlu persetujuan eksplisit, fixture sintetis, dan batas kredit.

## Concern yang menentukan keputusan

- **Keamanan dan privasi.** Aplikasi tetap loopback-only, tetapi `qodercli` mengirim konteks tugas yang diperlukan ke layanan model Qoder. Runtime binary dan autentikasi akun menambah ketergantungan baru; jangan klaim data tetap lokal. Mode permission yang melewati persetujuan dan tool shell bawaan bertentangan dengan batas repo. Tidak ada agent yang boleh mengubah status lamaran atau mengirim pesan.
- **Kualitas dan biaya.** Paket SDK tidak menjamin model lebih baik daripada provider Pi saat ini. Migrasi menghilangkan pilihan Google, Anthropic, dan OpenAI dalam branch Qoder. Kredit Qoder harus diukur pada tugas yang sama, bukan dibandingkan langsung dengan estimasi USD di SQLite.
- **Tes.** Qoder SDK tidak menawarkan `fauxProvider` Pi dalam API yang terdokumentasi. Menghapus fixture trajectory berarti kehilangan bukti deterministik; jangan menyebut kompilasi sukses sebagai paritas. Transport yang bisa disuntikkan belum terbukti dan harus diperiksa pada deklarasi paket terpasang serta entry point `./protocol`.
- **Semantik sesi dan event.** Sesi interview Pi bisa diprompt ulang, sedangkan string `query()` Qoder menutup sesi setelah satu putaran. Jenis event SDK berbeda. Terjemahan terpusat menjaga TRACE dan tes; mempertahankan teks output saja tidak cukup.
- **Bukan pekerjaan migrasi.** `src/server/runs.ts:849` memanggil `runRankVerifier` tanpa `execute`, sehingga `src/server/verifier.ts:99-104` melewati second opinion LLM. Catat sebagai temuan terpisah; jangan mengubahnya diam-diam dalam branch SDK.

## Peluang optimasi setelah paritas terbukti

Fitur di tabel ini berasal dari dokumentasi Qoder; belum ada benchmark atau panggilan live pada akun pengguna. Setiap eksperimen tetap tunduk pada loopback-only, gerbang approval manual, dan larangan mengekspos kredensial atau shell melalui UI. Jangan aktifkan preset tool bawaan demi mencoba fitur agent.

| Kemampuan Qoder | Eksperimen yang layak | Batas sebelum dipakai |
| --- | --- | --- |
| `getUsageInfo()` dan credit per-result | Ukur kredit per run dan biaya pencarian per posting valid. | Pakai unit terpisah; jangan masukkan kredit ke `estimatedCost` USD. Jangan tampilkan token autentikasi. |
| `resolveModel` atau tier model | Bandingkan tier hemat untuk parsing terstruktur dengan tier kuat untuk penalaran pencarian. | Jalankan pasangan fixture sintetis lebih dulu; panggilan live hanya dengan izin dan batas kredit. Jangan aktifkan fallback otomatis tanpa keputusan produk. |
| Partial messages dan hooks | Perbaiki progres SSE/TRACE tanpa polling tambahan. | Redaksi prompt, profil, posting, input tool, dan kredensial sebelum menulis event; ukur frekuensi serta ukuran event. |
| Skills dan `AgentDefinition`/subagents | Uji pembagian tugas pencarian hanya jika satu agent terbukti tidak cukup. | Wariskan `tools` dan `allowedTools` yang sempit pada setiap subagent. Jangan beri `Bash`, `Write`, `Edit`, atau akses data di luar tugas. Pertahankan batas anggaran lintas agent. |
| Native memory TypeScript | Uji apakah catatan lintas sesi menambah kualitas query. | Default mati. Jangan biarkan memory menyimpan CV atau posting pribadi; search memory SQLite tetap sumber kebenaran dan harus tetap dapat diaudit. |
| Checkpoint dan `rewindFiles()` | Evaluasi hanya untuk pekerjaan file dalam workspace sintetis terisolasi. | Bukan rollback SQLite atau data aplikasi; tidak boleh melewati approval pengguna. |
| Security scan Qoder | Bandingkan temuan pada kode sintetis atau branch eksperimen. | Tidak menambah izin shell/file pada agent produksi; audit aliran data dan biaya scan sebelum mengaktifkannya. |

Kriteria peningkatan: pada set tugas yang sama, Qoder harus mempertahankan semua gerbang keselamatan dan setidaknya menyamai rasio posting terverifikasi serta dokumen yang lolos audit. Klaim \"lebih baik\" memerlukan metrik kualitas, latensi, dan kredit dari uji berpasangan; daftar fitur SDK bukan bukti kualitas.

## Rujukan eksternal

- [Qoder Agent SDK: arsitektur dan batas eksekusi](https://docs.qoder.com/cli/sdk/overview)
- [Qoder Agent SDK: referensi TypeScript](https://docs.qoder.com/cli/sdk/references-typescript)
- [Qoder custom tools dan MCP](https://docs.qoder.com/cli/sdk/mcp)
- [Qoder permissions dan approval](https://docs.qoder.com/cli/sdk/permissions)
- [Qoder input multi-turn](https://docs.qoder.com/cli/sdk/input-modes)
- [Qoder model selection](https://docs.qoder.com/cli/sdk/model-policy)
- [Qoder cost and usage](https://docs.qoder.com/cli/sdk/cost-usage)
- [Qoder Cloud Agent eksperimental](https://docs.qoder.com/cli/sdk/cloud-agent)
- [Paket Qoder Agent SDK di npm](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk)
- [Paket ekstensi pihak ketiga `pi-provider-qoder`](https://www.npmjs.com/package/pi-provider-qoder)
