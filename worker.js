
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. CORS SOZLAMALARI
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 2. JSON JAVOB
    const jsonResponse = (data, status = 200) => {
      return Response.json(data, {
        status,
        headers: corsHeaders
      });
    };

    // 3. ADMIN PAROLINI TEKSHIRISH
    const checkAdmin = () => {
      const auth = request.headers.get("Authorization");

      return Boolean(
        env.ADMIN_PASSWORD &&
        auth === `Bearer ${env.ADMIN_PASSWORD}`
      );
    };

    try {

      // =====================================
      // 4. YANGI BUYURTMA QABUL QILISH
      // =====================================

      if (
        url.pathname === "/api/order" &&
        request.method === "POST"
      ) {
        const data = await request.json();

        if (
          !data.name ||
          !data.phone ||
          !data.service ||
          !data.address
        ) {
          return jsonResponse({
            error: "Majburiy ma'lumotlar kiritilmagan"
          }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO orders
          (name, phone, service, address, details, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          String(data.name).trim(),
          String(data.phone).trim(),
          String(data.service).trim(),
          String(data.address).trim(),
          String(data.details || "").trim(),
          "Yangi"
        ).run();

        const orderId = result.meta.last_row_id;

        const message =
          "🛠 USTA 24 — YANGI BUYURTMA\n\n" +
          "🆔 Buyurtma: #" + orderId + "\n" +
          "👤 Ism: " + data.name + "\n" +
          "📞 Telefon: " + data.phone + "\n" +
          "🔧 Xizmat: " + data.service + "\n" +
          "📍 Manzil: " + data.address + "\n" +
          "📝 Izoh: " + (data.details || "Yo'q") + "\n" +
          "📌 Holati: Yangi";

        let telegramSent = false;

        if (
          env.TELEGRAM_BOT_TOKEN &&
          env.TELEGRAM_CHAT_ID
        ) {
          try {
            const telegram = await fetch(
              `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  chat_id: env.TELEGRAM_CHAT_ID,
                  text: message
                })
              }
            );

            const telegramResult = await telegram.json();
            telegramSent = telegram.ok && telegramResult.ok;

          } catch (error) {
            console.error("Telegram xatosi:", error);
          }
        }

        return jsonResponse({
          success: true,
          orderId,
          saved: true,
          telegramSent
        }, 201);
      }

      // =====================================
      // 5. BARCHA BUYURTMALAR
      // =====================================

      if (
        url.pathname === "/api/admin/orders" &&
        request.method === "GET"
      ) {
        if (!checkAdmin()) {
          return jsonResponse({ error: "Ruxsat yo'q" }, 401);
        }

        const result = await env.DB.prepare(`
          SELECT * FROM orders
          ORDER BY id DESC
        `).all();

        return jsonResponse({
          success: true,
          orders: result.results
        });
      }

      // =====================================
      // 6. BITTA BUYURTMANI KO'RISH
      // =====================================

      if (
        url.pathname.startsWith("/api/admin/orders/") &&
        request.method === "GET"
      ) {
        if (!checkAdmin()) {
          return jsonResponse({ error: "Ruxsat yo'q" }, 401);
        }

        const id = Number(url.pathname.split("/").pop());

        if (!Number.isInteger(id) || id < 1) {
          return jsonResponse({ error: "Buyurtma ID noto'g'ri" }, 400);
        }

        const order = await env.DB.prepare(`
          SELECT * FROM orders WHERE id = ?
        `).bind(id).first();

        if (!order) {
          return jsonResponse({ error: "Buyurtma topilmadi" }, 404);
        }

        return jsonResponse({
          success: true,
          order
        });
      }

      // =====================================
      // 7. BUYURTMA HOLATINI O'ZGARTIRISH
      // =====================================

      if (
        url.pathname.startsWith("/api/admin/orders/") &&
        request.method === "PATCH"
      ) {
        if (!checkAdmin()) {
          return jsonResponse({ error: "Ruxsat yo'q" }, 401);
        }

        const id = Number(url.pathname.split("/").pop());

        if (!Number.isInteger(id) || id < 1) {
          return jsonResponse({ error: "Buyurtma ID noto'g'ri" }, 400);
        }

        const data = await request.json();

        const allowedStatuses = [
          "Yangi",
          "Qabul qilindi",
          "Ustaga biriktirildi",
          "Bajarilmoqda",
          "Tugallandi",
          "Bekor qilindi"
        ];

        if (!allowedStatuses.includes(data.status)) {
          return jsonResponse({ error: "Buyurtma holati noto'g'ri" }, 400);
        }

        const result = await env.DB.prepare(`
          UPDATE orders
          SET status = ?
          WHERE id = ?
        `).bind(data.status, id).run();

        if (result.meta.changes === 0) {
          return jsonResponse({ error: "Buyurtma topilmadi" }, 404);
        }

        return jsonResponse({
          success: true,
          message: "Buyurtma holati yangilandi",
          orderId: id,
          status: data.status
        });
      }

      // =====================================
      // 8. BUYURTMALAR STATISTIKASI
      // =====================================

      if (
        url.pathname === "/api/admin/stats" &&
        request.method === "GET"
      ) {
        if (!checkAdmin()) {
          return jsonResponse({ error: "Ruxsat yo'q" }, 401);
        }

        const result = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            COALESCE(
              SUM(CASE WHEN status = 'Yangi' THEN 1 ELSE 0 END), 0
            ) AS new_orders,
            COALESCE(
              SUM(CASE WHEN status = 'Bajarilmoqda' THEN 1 ELSE 0 END), 0
            ) AS in_progress,
            COALESCE(
              SUM(CASE WHEN status = 'Tugallandi' THEN 1 ELSE 0 END), 0
            ) AS completed
          FROM orders
        `).first();

        return jsonResponse({
          success: true,
          stats: result
        });
      }

      // =====================================
      // 9. BARCHA USTALARNI OLISH
      // =====================================

      if (
        url.pathname === "/api/admin/ustalar" &&
        request.method === "GET"
      ) {
        if (!checkAdmin()) {
          return jsonResponse({ error: "Ruxsat yo'q" }, 401);
        }

        const result = await env.DB.prepare(`
          SELECT * FROM ustalar
          ORDER BY id DESC
        `).all();

        return jsonResponse({
          success: true,
          ustalar: result.results
        });
      }

      // =====================================
      // 10. YANGI USTA QO'SHISH
      // =====================================

      if (
        url.pathname === "/api/admin/ustalar" &&
        request.method === "POST"
      ) {
        if (!checkAdmin()) {
          return jsonResponse({ error: "Ruxsat yo'q" }, 401);
        }

        const data = await request.json();

        if (
          !data.name ||
          !data.phone ||
          !String(data.name).trim() ||
          !String(data.phone).trim()
        ) {
          return jsonResponse({
            error: "Ustaning ismi va telefoni majburiy"
          }, 400);
        }

        const status = data.status || "Faol";

        if (!["Faol", "Nofaol"].includes(status)) {
          return jsonResponse({
            error: "Holat noto'g'ri"
          }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO ustalar
          (name, phone, specialty, status)
          VALUES (?, ?, ?, ?)
        `).bind(
          String(data.name).trim(),
          String(data.phone).trim(),
          String(data.specialty || "").trim(),
          status
        ).run();

        return jsonResponse({
          success: true,
          message: "Usta muvaffaqiyatli qo'shildi",
          id: result.meta.last_row_id
        }, 201);
      }

      // =====================================
      // 11. USTA MA'LUMOTLARINI TAHRIRLASH
      // =====================================

      if (
        url.pathname.startsWith("/api/admin/ustalar/") &&
        request.method === "PATCH"
      ) {
        if (!checkAdmin()) {
          return jsonResponse({ error: "Ruxsat yo'q" }, 401);
        }

        const id = Number(url.pathname.split("/").pop());

        if (!Number.isInteger(id) || id < 1) {
          return jsonResponse({ error: "Usta ID noto'g'ri" }, 400);
        }

        const data = await request.json();

        if (
          !data.name ||
          !data.phone ||
          !String(data.name).trim() ||
          !String(data.phone).trim()
        ) {
          return jsonResponse({
            error: "Ism va telefon majburiy"
          }, 400);
        }

        const status = data.status || "Faol";

        if (!["Faol", "Nofaol"].includes(status)) {
          return jsonResponse({ error: "Holat noto'g'ri" }, 400);
        }

        const existing = await env.DB.prepare(`
          SELECT id FROM ustalar WHERE id = ?
        `).bind(id).first();

        if (!existing) {
          return jsonResponse({ error: "Usta topilmadi" }, 404);
        }

        await env.DB.prepare(`
          UPDATE ustalar
          SET name = ?, phone = ?, specialty = ?, status = ?
          WHERE id = ?
        `).bind(
          String(data.name).trim(),
          String(data.phone).trim(),
          String(data.specialty || "").trim(),
          status,
          id
        ).run();

        return jsonResponse({
          success: true,
          message: "Usta muvaffaqiyatli yangilandi",
          id
        });
      }

      // =====================================
      // 12. USTANI O'CHIRISH
      // =====================================

      if (
        url.pathname.startsWith("/api/admin/ustalar/") &&
        request.method === "DELETE"
      ) {
        if (!checkAdmin()) {
          return jsonResponse({ error: "Ruxsat yo'q" }, 401);
        }

        const id = Number(url.pathname.split("/").pop());

        if (!Number.isInteger(id) || id < 1) {
          return jsonResponse({ error: "Usta ID noto'g'ri" }, 400);
        }

        const result = await env.DB.prepare(`
          DELETE FROM ustalar WHERE id = ?
        `).bind(id).run();

        if (result.meta.changes === 0) {
          return jsonResponse({ error: "Usta topilmadi" }, 404);
        }

        return jsonResponse({
          success: true,
          message: "Usta muvaffaqiyatli o'chirildi",
          id
        });
      }

      // =====================================
      // 13. TOPILMAGAN API
      // =====================================

      if (url.pathname.startsWith("/api/")) {
        return jsonResponse({
          error: "API manzili topilmadi"
        }, 404);
      }

      // =====================================
      // 14. SAYT FAYLLARINI OCHISH
      // =====================================

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error(
        "SERVER ERROR DETAILS:",
        error?.message,
        error?.stack
      );

      return jsonResponse({
        error: "Server xatosi",
        message: error?.message || "Noma'lum xato"
      }, 500);
    }
  }
};

