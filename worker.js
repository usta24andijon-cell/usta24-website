
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    };

    const checkAdmin = () => {
      const auth = request.headers.get("Authorization") || "";
      const password = auth.startsWith("Bearer ")
        ? auth.slice(7)
        : "";

      return Boolean(
        env.ADMIN_PASSWORD &&
        password &&
        password === env.ADMIN_PASSWORD
      );
    };

    const readBody = async () => {
      try {
        return await request.json();
      } catch {
        return null;
      }
    };

    // TELEGRAM XABAR YUBORISH
    const sendTelegram = async (chatId, message) => {
      if (!env.TELEGRAM_BOT_TOKEN) {
        console.error("TELEGRAM_BOT_TOKEN SOZLANMAGAN");
        return false;
      }

      if (!chatId) {
        console.error("TELEGRAM CHAT_ID SOZLANMAGAN");
        return false;
      }

      try {
        const response = await fetch(
          "https://api.telegram.org/bot" +
          env.TELEGRAM_BOT_TOKEN +
          "/sendMessage",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: message
            })
          }
        );

        const result = await response.json();

        if (!response.ok || result.ok !== true) {
          console.error(
            "TELEGRAM API XATOSI:",
            response.status,
            result.description || JSON.stringify(result)
          );
          return false;
        }

        console.log("TELEGRAM XABARI YUBORILDI");
        return true;

      } catch (error) {
        console.error("TELEGRAM ULANISH XATOSI:", error);
        return false;
      }
    };

    try {

      // 1. MIJOZ BUYURTMASI

      if (
        url.pathname === "/api/order" &&
        request.method === "POST"
      ) {
        if (!env.DB) {
          return jsonResponse({
            success: false,
            error: "D1 DB sozlanmagan"
          }, 500);
        }

        const data = await readBody();

        if (!data) {
          return jsonResponse({
            success: false,
            error: "Ma'lumot noto'g'ri"
          }, 400);
        }

        const name = String(data.name || "").trim();
        const phone = String(data.phone || "").trim();
        const service = String(data.service || "").trim();
        const address = String(data.address || "").trim();
        const details = String(data.details || "").trim();

        if (!name || !phone || !service || !address) {
          return jsonResponse({
            success: false,
            error: "Ism, telefon, xizmat va manzil majburiy"
          }, 400);
        }

        const saved = await env.DB.prepare(`
          INSERT INTO orders
            (name, phone, service, address, details, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'Yangi', datetime('now'))
        `).bind(
          name,
          phone,
          service,
          address,
          details
        ).run();

        const orderId = saved.meta?.last_row_id || null;

        const message =
          "🆕 USTA 24 — YANGI BUYURTMA\n\n" +
          "🆔 Buyurtma: #" + (orderId || "") + "\n" +
          "👤 Ism: " + name + "\n" +
          "📞 Telefon: " + phone + "\n" +
          "🔧 Xizmat: " + service + "\n" +
          "📍 Manzil: " + address + "\n" +
          "📝 Izoh: " + (details || "Yo'q") + "\n" +
          "📌 Holat: Yangi";

        const telegramSent = await sendTelegram(
          env.TELEGRAM_CHAT_ID,
          message
        );

        return jsonResponse({
          success: true,
          message: "Buyurtma saqlandi",
          orderId,
          telegramSent
        });
      }

      // 2. SAYTDA FAOL USTALAR

      if (
        url.pathname === "/api/ustalar" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(`
          SELECT id, name, phone, specialty, status
          FROM ustalar
          WHERE status = 'Faol'
          ORDER BY id DESC
        `).all();

        return jsonResponse({
          success: true,
          ustalar: result.results || []
        });
      }

      // 3. ADMIN RUXSATI

      if (url.pathname.startsWith("/api/admin/")) {
        if (!checkAdmin()) {
          return jsonResponse({
            success: false,
            error: "Ruxsat yo'q. Admin parolini tekshiring."
          }, 401);
        }
      }

      // 4. ADMIN STATISTIKASI

      if (
        url.pathname === "/api/admin/stats" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'Yangi' THEN 1 ELSE 0 END)
              AS new_orders,
            SUM(CASE
              WHEN status IN (
                'Qabul qilindi',
                'Ustaga biriktirildi',
                'Bajarilmoqda'
              )
              THEN 1 ELSE 0
            END) AS in_progress,
            SUM(CASE WHEN status = 'Tugallandi' THEN 1 ELSE 0 END)
              AS completed
          FROM orders
        `).first();

        return jsonResponse({
          success: true,
          stats: {
            total: result?.total || 0,
            new_orders: result?.new_orders || 0,
            in_progress: result?.in_progress || 0,
            completed: result?.completed || 0
          }
        });
      }

      // 5. ADMIN BUYURTMALARI

      if (
        url.pathname === "/api/admin/orders" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(`
          SELECT
            id,
            name,
            phone,
            service,
            address,
            details,
            status,
            created_at,
            worker_name,
            worker_phone
          FROM orders
          ORDER BY id DESC
        `).all();

        return jsonResponse({
          success: true,
          orders: result.results || []
        });
      }

      // 6. USTALAR RO'YXATI

      if (
        url.pathname === "/api/admin/ustalar" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(`
          SELECT id, name, phone, specialty, status, created_at
          FROM ustalar
          ORDER BY id DESC
        `).all();

        return jsonResponse({
          success: true,
          ustalar: result.results || []
        });
      }

      // 7. USTA QO'SHISH

      if (
        url.pathname === "/api/admin/ustalar" &&
        request.method === "POST"
      ) {
        const data = await readBody();

        if (!data) {
          return jsonResponse({
            error: "Ma'lumot noto'g'ri"
          }, 400);
        }

        const name = String(data.name || "").trim();
        const phone = String(data.phone || "").trim();
        const specialty = String(data.specialty || "").trim();
        const status = String(data.status || "Faol");

        if (!name || !phone) {
          return jsonResponse({
            error: "Usta ismi va telefoni kerak"
          }, 400);
        }

        if (!["Faol", "Nofaol"].includes(status)) {
          return jsonResponse({
            error: "Usta holati noto'g'ri"
          }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO ustalar (name, phone, specialty, status)
          VALUES (?, ?, ?, ?)
        `).bind(name, phone, specialty, status).run();

        return jsonResponse({
          success: true,
          message: "Usta qo'shildi",
          id: result.meta?.last_row_id || null
        });
      }

      // 8. USTANI TAHRIRLASH VA O'CHIRISH

      if (
        url.pathname.startsWith("/api/admin/ustalar/") &&
        ["PATCH", "DELETE"].includes(request.method)
      ) {
        const id = Number(url.pathname.split("/").pop());

        if (!Number.isInteger(id) || id < 1) {
          return jsonResponse({
            error: "Usta ID noto'g'ri"
          }, 400);
        }

        const worker = await env.DB.prepare(`
          SELECT id FROM ustalar WHERE id = ?
        `).bind(id).first();

        if (!worker) {
          return jsonResponse({
            error: "Usta topilmadi"
          }, 404);
        }

        if (request.method === "DELETE") {
          await env.DB.prepare(`
            DELETE FROM ustalar WHERE id = ?
          `).bind(id).run();

          return jsonResponse({
            success: true,
            message: "Usta o'chirildi"
          });
        }

        const data = await readBody();

        if (!data) {
          return jsonResponse({
            error: "Ma'lumot noto'g'ri"
          }, 400);
        }

        const name = String(data.name || "").trim();
        const phone = String(data.phone || "").trim();
        const specialty = String(data.specialty || "").trim();
        const status = String(data.status || "Faol");

        if (!name || !phone) {
          return jsonResponse({
            error: "Ism va telefon kerak"
          }, 400);
        }

        if (!["Faol", "Nofaol"].includes(status)) {
          return jsonResponse({
            error: "Usta holati noto'g'ri"
          }, 400);
        }

        await env.DB.prepare(`
          UPDATE ustalar
          SET name = ?,
              phone = ?,
              specialty = ?,
              status = ?
          WHERE id = ?
        `).bind(name, phone, specialty, status, id).run();

        return jsonResponse({
          success: true,
          message: "Usta yangilandi"
        });
      }

      // 9. BUYURTMAGA USTA BIRIKTIRISH

      if (
        url.pathname.startsWith("/api/admin/orders/") &&
        request.method === "PATCH"
      ) {
        const id = Number(url.pathname.split("/").pop());

        if (!Number.isInteger(id) || id < 1) {
          return jsonResponse({
            error: "Buyurtma ID noto'g'ri"
          }, 400);
        }

        const data = await readBody();

        if (!data) {
          return jsonResponse({
            error: "Ma'lumot noto'g'ri"
          }, 400);
        }

        const order = await env.DB.prepare(`
          SELECT * FROM orders WHERE id = ?
        `).bind(id).first();

        if (!order) {
          return jsonResponse({
            error: "Buyurtma topilmadi"
          }, 404);
        }

        // USTANI BIRIKTIRISH

        if (
          data.worker_name !== undefined ||
          data.worker_phone !== undefined
        ) {
          const workerName = String(data.worker_name || "").trim();
          const workerPhone = String(data.worker_phone || "").trim();

          if (!workerName || !workerPhone) {
            return jsonResponse({
              error: "Usta ismi va telefoni kerak"
            }, 400);
          }

          const worker = await env.DB.prepare(`
            SELECT id FROM ustalar
            WHERE name = ?
              AND phone = ?
              AND status = 'Faol'
          `).bind(workerName, workerPhone).first();

          if (!worker) {
            return jsonResponse({
              error: "Faol usta topilmadi"
            }, 404);
          }

          await env.DB.prepare(`
            UPDATE orders
            SET worker_name = ?,
                worker_phone = ?,
                status = 'Ustaga biriktirildi'
            WHERE id = ?
          `).bind(workerName, workerPhone, id).run();

          // USTA24 TELEGRAMIGA XABAR

          const workerMessage =
            "🔔 USTA 24 — YANGI BUYURTMA BIRIKTIRILDI\n\n" +
            "🆔 Buyurtma: #" + id + "\n" +
            "👤 Mijoz: " + order.name + "\n" +
            "📞 Telefon: " + order.phone + "\n" +
            "🔧 Xizmat: " + order.service + "\n" +
            "📍 Manzil: " + order.address + "\n" +
            "📝 Izoh: " + (order.details || "Yo'q") + "\n" +
            "👨‍🔧 Biriktirilgan usta: " + workerName + "\n" +
            "📱 Usta telefoni: " + workerPhone + "\n" +
            "📌 Holat: Ustaga biriktirildi";

          const workerTelegramSent = await sendTelegram(
            env.USTA24_CHAT_ID,
            workerMessage
          );

          return jsonResponse({
            success: true,
            message: "Usta buyurtmaga biriktirildi",
            orderId: id,
            worker_name: workerName,
            worker_phone: workerPhone,
            status: "Ustaga biriktirildi",
            workerTelegramSent
          });
        }

        // BUYURTMA HOLATINI O'ZGARTIRISH

        const allowedStatuses = [
          "Yangi",
          "Qabul qilindi",
          "Ustaga biriktirildi",
          "Bajarilmoqda",
          "Tugallandi",
          "Bekor qilindi"
        ];

        if (!allowedStatuses.includes(data.status)) {
          return jsonResponse({
            error: "Buyurtma holati noto'g'ri"
          }, 400);
        }

        await env.DB.prepare(`
          UPDATE orders
          SET status = ?
          WHERE id = ?
        `).bind(data.status, id).run();

        return jsonResponse({
          success: true,
          message: "Buyurtma holati yangilandi",
          orderId: id,
          status: data.status
        });
      }

      // 10. TOPILMAGAN API

      if (url.pathname.startsWith("/api/")) {
        return jsonResponse({
          success: false,
          error: "API manzili topilmadi"
        }, 404);
      }

      // 11. SAYT FAYLLARI

      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response("ASSETS binding topilmadi", {
        status: 500
      });

    } catch (error) {
      console.error("SERVER XATOSI:", error);

      return jsonResponse({
        success: false,
        error: "Serverda xatolik yuz berdi"
      }, 500);
    }
  }
};
