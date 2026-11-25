[README_UZ.txt](https://github.com/user-attachments/files/35435391/README_UZ.txt)
USTA24 YANGILANGAN SAYT — JOYLASHTIRISH TARTIBI

Fayllar:
- migration.sql — D1 bazaga yangi ustun/jadvallar qo'shadi (bir marta bajariladi)
- worker.js — API va Cloudflare Worker kodi
- index.html — mijozlar sayti
- admin.html — boshqaruv paneli

MUHIM: avval D1 bazaning backup nusxasini oling. Mavjud buyurtmalarni o'chirmang.

1) Cloudflare Dashboard > Workers & Pages > D1 > usta24_db > Console.
2) migration.sql ichidagi SQL buyruqlarini bir marta ishga tushiring. Agar photo_url, experience_years yoki bio ustunlari oldin qo'shilgan bo'lsa, shu ALTER TABLE qatorlarini qayta ishlatmang; faqat CREATE TABLE IF NOT EXISTS qismini bajaring.
3) GitHub usta24andijon-cell/usta24-website reposida worker.js, index.html, admin.html fayllarini almashtiring. README_UZ.txt va migration.sql ni deploy uchun majburiy emas.
4) Commit va Deploy qiling.
5) Saytni / va adminni /admin manzilida tekshiring. Admin paroli Cloudflare secret ADMIN_PASSWORD bilan bir xil bo'lishi kerak.

RASMLAR: admin panel hozircha HTTPS rasm URL qabul qiladi. Rasm yuklashni to'g'ridan-to'g'ri kompyuterdan qilish uchun keyingi bosqichda Cloudflare R2 binding va upload API qo'shish kerak.

REAL-TIME: admin panel buyurtmalarni 5 soniyada bir yangilaydi; Telegram botdan kelgan status ham shu oraliqda aks etadi.

ESLATMA: SQL migratsiyani backup olmasdan bajarmang. Bu migration mavjud yozuvlarni o'chirmaydi, lekin ALTER TABLE ustunlari faqat bir marta qo'shiladi.
