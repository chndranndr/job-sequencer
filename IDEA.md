# Personal Job Search Assistant

Local dashboard untuk membantu satu user menjalankan proses pencarian kerja dari awal sampai follow-up dengan bantuan Pi Coding Agent.

## Ide utama

User mengisi profil dan kriteria pekerjaan, lalu menjalankan setiap tahap secara manual:

```text
Isi profil dan kriteria
→ Scrape dan rank jobs
→ Pilih job yang menarik
→ Generate CV dan cover letter
→ Review dan approve
→ Apply sendiri
→ Tandai Applied
→ Latihan interview lewat chat
→ Draft follow-up
→ Kirim follow-up sendiri
```

Workflow tidak berjalan otomatis dari awal sampai akhir. Setiap tahap berhenti dan menunggu tindakan user berikutnya.

## Prinsip produk

- Personal, local-first, dan hanya berjalan di `127.0.0.1`.
- Pi mencari dan memberi fit score berdasarkan profil serta kriteria user.
- Job di bawah threshold disimpan sebagai Discarded, bukan dihapus.
- User selalu memilih sendiri job yang ingin dilanjutkan.
- Pi membuat CV dan cover letter dari fakta yang sudah diverifikasi.
- Human approval wajib sebelum dokumen digunakan.
- Apply dan pengiriman follow-up selalu dilakukan manual oleh user.
- Interview chat memakai konteks job, profil, CV, dan cover letter terkait.

## Implementasi ringkas

- TypeScript dan Node.js
- React + Vite
- Fastify
- SQLite
- `@earendil-works/pi-coding-agent`
- Existing skills dari `vendor/ai-job-search-skills` direuse, bukan diimplementasikan ulang
- Existing job-search CLIs dibungkus sebagai restricted Pi tools tanpa memberi Pi akses shell umum

Project ini bukan SaaS dan tidak membutuhkan akun, multi-user, billing, cloud deployment, generic workflow engine, atau autonomous job submission.

Detail implementasi lengkap berada di `docs/GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md`.
