
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS sozlamalari
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // JSON javob qaytarish
    const jsonResponse = (data, status = 200) => {
      return Response.json(data, {
        status,
        headers: corsHeaders
      });
    };

    // ADMIN tekshiruvi
    const checkAdmin = () => {
      const auth = request.headers.get("Authorization");
      return (
        env.ADMIN_PASSWORD &&
        auth === `Bearer ${env.ADMIN_PASSWORD}`
      );
    };

    try {

      // 1. YANGI BUYURTMA QABUL QILISH
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
          return jsonResponse(
            { error: "Majburiy ma'lumotlar kiritilmagan" },
            400
          );
        }

        // Buyurtmani D1 bazasiga saqlash
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

        // Telegram xabari
        const message =
          "🛠 USTA 24 — YANGI BUYURTMA\n\n" +
          "🆔 Buyurtma: #" + orderId + "\n" +
          "👤 Ism: " + data.name + "\n" +
          "📞 Telefon: " + data.phone + "\n" +
          "🔧 Xizmat: " + data.service + "\n" +
          "📍 Manzil: " + data.address + "\n" +
          "📝 Izoh: " + (data.details || "Yo'q") + "\n" +
          "📌 Holati: Yangi";

        // Telegramga yuborish
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

        if (!telegram.ok) {
          const errorText = await telegram.text();
          console.error("Telegram xatosi:", errorText);

          // Buyurtma bazada saqlangan, lekin Telegram xabarida xato bor.
          return jsonResponse({
            success: true,
            orderId,
            saved: true,
            telegramSent: false
          }, 201);
        }

        return jsonResponse({
          success: true,
          orderId,
          saved: true,
          telegramSent: true
        }, 201);
      }

      // 2. BARCHA BUYURTMALARNI KO'RISH
      if (
        url.pathname === "/api/admin/orders" &&
        request.method === "GET"
      ) {
        if (!checkAdmin()) {
          return jsonResponse(
            { error: "Ruxsat yo'q" },
            401
          );
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

      // 3. BITTA BUYURTMANI KO'RISH
      if (
        url.pathname.startsWith("/api/admin/orders/") &&
        request.method === "GET"
      ) {
        if (!checkAdmin()) {
          return jsonResponse(
            { error: "Ruxsat yo'q" },
            401
          );
        }

        const id = Number(
          url.pathname.split("/").pop()
        );

        if (!Number.isInteger(id) || id < 1) {
          return jsonResponse(
            { error: "Buyurtma ID noto'g'ri" },
            400
          );
        }

        const order = await env.DB.prepare(
          "SELECT * FROM orders WHERE id = ?"
        ).bind(id).first();

        if (!order) {
          return jsonResponse(
            { error: "Buyurtma topilmadi" },
            404
          );
        }

        return jsonResponse({
          success: true,
          order
        });
      }

      // 4. BUYURTMA HOLATINI O'ZGARTIRISH
      if (
        url.pathname.startsWith("/api/admin/orders/") &&
        request.method === "PATCH"
      ) {
        if (!checkAdmin()) {
          return jsonResponse(
            { error: "Ruxsat yo'q" },
            401
          );
        }

        const id = Number(
          url.pathname.split("/").pop()
        );

        if (!Number.isInteger(id) || id < 1) {
          return jsonResponse(
            { error: "Buyurtma ID noto'g'ri" },
            400
          );
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
          return jsonResponse(
            { error: "Buyurtma holati noto'g'ri" },
            400
          );
        }

        const result = await env.DB.prepare(`
          UPDATE orders
          SET status = ?
          WHERE id = ?
        `).bind(data.status, id).run();

        if (result.meta.changes === 0) {
          return jsonResponse(
            { error: "Buyurtma topilmadi" },
            404
          );
        }

        return jsonResponse({
          success: true,
          message: "Buyurtma holati yangilandi",
          orderId: id,
          status: data.status
        });
      }

      // 5. BUYURTMALAR SONI
      if (
        url.pathname === "/api/admin/stats" &&
        request.method === "GET"
      ) {
        if (!checkAdmin()) {
          return jsonResponse(
            { error: "Ruxsat yo'q" },
            401
          );
        }

        const result = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'Yangi' THEN 1 ELSE 0 END) AS new_orders,
            SUM(CASE WHEN status = 'Bajarilmoqda' THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN status = 'Tugallandi' THEN 1 ELSE 0 END) AS completed
          FROM orders
        `).first();

        return jsonResponse({
          success: true,
          stats: result
        });
      }

      // 6. TOPILMAGAN API
      if (url.pathname.startsWith("/api/")) {
        return jsonResponse(
          { error: "API manzili topilmadi" },
          404
        );
      }

      // Oddiy sayt fayllarini chiqarish
      return env.ASSETS.fetch(request);
} catch (error) {
  console.error("SERVER ERROR DETAILS:", error?.message, error?.stack);

  return jsonResponse(
    { error: error?.message || "Server xatosi" },
    500
  );
}
    

      return jsonResponse(
        { error: "Server xatosi" },
        500
      );
    }
  }
};
