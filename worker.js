
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

    // TELEFON RAQAMINI BIR XIL FORMATGA KELTIRISH
    const normalizePhone = (value) => {
      let digits = String(value || "").replace(/\D/g, "");

      if (digits.startsWith("00")) {
        digits = digits.slice(2);
      }

      if (digits.length === 9) {
        digits = "998" + digits;
      }

      return digits;
    };

    // ESKI ADMIN TELEGRAM BOTI
    const sendTelegram = async (chatId, message) => {
      if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
        console.error("ADMIN TELEGRAM SOZLANMAGAN");
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
          console.error("ADMIN TELEGRAM XATOSI:", result.description);
          return false;
        }

        return true;
      } catch (error) {
        console.error("ADMIN TELEGRAM ULANISH XATOSI:", error);
        return false;
      }
    };

    // YANGI MIJOZ TELEGRAM BOTI
    const sendCustomerTelegram = async (chatId, message, extra = {}) => {
      if (!env.CUSTOMER_BOT_TOKEN || !chatId) {
        console.error("MIJOZ BOT TOKENI YOKI CHAT ID YO'Q");
        return false;
      }

      try {
        const response = await fetch(
          "https://api.telegram.org/bot" +
          env.CUSTOMER_BOT_TOKEN +
          "/sendMessage",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              ...extra
            })
          }
        );

        const result = await response.json();

        if (!response.ok || result.ok !== true) {
          console.error("MIJOZ TELEGRAM XATOSI:", result.description);
          return false;
        }

        return true;
      } catch (error) {
        console.error("MIJOZ TELEGRAM ULANISH XATOSI:", error);
        return false;
      }
    };

    // MIJOZGA TELEGRAM ORQALI XABAR YUBORISH
    const notifyCustomer = async (phone, message) => {
      const normalized = normalizePhone(phone);

      if (!normalized) {
        return false;
      }

      try {
        const customer = await env.DB.prepare(`
          SELECT chat_id
          FROM customer_telegram
          WHERE phone = ?
          LIMIT 1
        `).bind(normalized).first();

        if (!customer?.chat_id) {
          console.log("MIJOZ TELEGRAMGA ULANMAGAN:", normalized);
          return false;
        }

        return await sendCustomerTelegram(
          customer.chat_id,
          message
        );
      } catch (error) {
        console.error("MIJOZNI TOPISHDA XATO:", error);
        return false;
      }
    };

    try {

      // 1. MIJOZ TELEGRAM BOTI WEBHOOK

      if (
        url.pathname === "/api/customer-telegram-webhook" &&
        request.method === "POST"
      ) {
        const secret = request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        );

        if (
          !env.CUSTOMER_BOT_WEBHOOK_SECRET ||
          secret !== env.CUSTOMER_BOT_WEBHOOK_SECRET
        ) {
          return jsonResponse({
            success: false,
            error: "Webhook ruxsati yo'q"
          }, 403);
        }

        if (!env.DB) {
          return jsonResponse({
            success: false,
            error: "D1 DB sozlanmagan"
          }, 500);
        }

        const update = await readBody();
        const msg = update?.message;

        if (!msg?.chat?.id) {
          return jsonResponse({ success: true });
        }

        const chatId = String(msg.chat.id);
        const messageText = String(msg.text || "");

        // MIJOZ START BOSGANDA
        if (messageText.startsWith("/start")) {
          await sendCustomerTelegram(
            chatId,
            "Assalomu alaykum!\n\n" +
            "USTA 24 mijozlar botiga xush kelibsiz.\n\n" +
            "Buyurtmangiz holati va sizga biriktirilgan usta haqida xabar olish uchun telefon raqamingizni tasdiqlang.\n\n" +
            "Quyidagi tugmani bosing:",
            {
              reply_markup: {
                keyboard: [[
                  {
                    text: "📱 Telefon raqamimni yuborish",
                    request_contact: true
                  }
                ]],
                resize_keyboard: true,
                one_time_keyboard: true
              }
            }
          );

          return jsonResponse({ success: true });
        }

        // MIJOZ TELEFONINI YUBORGANDA
        if (msg.contact) {
          const contact = msg.contact;

          // FAQAT MIJOZNING O'Z TELEFONI QABUL QILINADI
          if (
            !msg.from ||
            !contact.user_id ||
            Number(contact.user_id) !== Number(msg.from.id)
          ) {
            await sendCustomerTelegram(
              chatId,
              "Iltimos, faqat o'zingizning telefon raqamingizni tugma orqali yuboring."
            );

            return jsonResponse({ success: true });
          }

          const phone = normalizePhone(contact.phone_number);

          if (!phone || phone.length < 10) {
            await sendCustomerTelegram(
              chatId,
              "Telefon raqami noto'g'ri. Iltimos, qaytadan yuboring."
            );

            return jsonResponse({ success: true });
          }

          await env.DB.prepare(`
            INSERT INTO customer_telegram
              (phone, chat_id, customer_name)
            VALUES (?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET
              chat_id = excluded.chat_id,
              customer_name = excluded.customer_name
          `).bind(
            phone,
            chatId,
            String(msg.from.first_name || "")
          ).run();

          await sendCustomerTelegram(
            chatId,
            "✅ Telefon raqamingiz tasdiqlandi!\n\n" +
            "Endi USTA 24 buyurtmalaringiz va sizga biriktirilgan usta haqidagi xabarlarni shu bot orqali olasiz.",
            {
              reply_markup: {
                remove_keyboard: true
              }
            }
          );

          return jsonResponse({ success: true });
        }

        return jsonResponse({ success: true });
      }

      // 2. MIJOZ BUYURTMASI

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

        // ADMIN TELEGRAM GURUHIGA XABAR
        const adminMessage =
          "🆕 USTA 24 — YANGI BUYURTMA\n\n" +
          "🆔 Buyurtma: #" + (orderId || "") + "\n" +
          "👤 Ism: " + name + "\n" +
          "📞 Telefon: " + phone + "\n" +
          "🔧 Xizmat: " + service + "\n" +
          "📍 Manzil: " + address + "\n" +
          "📝 Izoh: " + (details || "Yo'q") + "\n" +
          "📌 Holat: Yangi";

        let telegramSent = false;

        try {
          telegramSent = await sendTelegram(
            env.TELEGRAM_CHAT_ID,
            adminMessage
          );
        } catch (error) {
          console.error("ADMIN GURUH XABAR XATOSI:", error);
        }

        // MIJOZGA BUYURTMA QABUL QILINGANI HAQIDA XABAR
        const customerMessage =
          "✅ USTA 24 — BUYURTMANGIZ QABUL QILINDI\n\n" +
          "🆔 Buyurtma: #" + (orderId || "") + "\n" +
          "🔧 Xizmat: " + service + "\n" +
          "📌 Holat: Yangi\n\n" +
          "Sizga usta biriktirilganda alohida xabar yuboramiz.";

        const customerNotified = await notifyCustomer(
          phone,
          customerMessage
        );

        return jsonResponse({
          success: true,
          message: "Buyurtma saqlandi",
          orderId,
          telegramSent,
          customerNotified
        });
      }

      // 3. SAYTDA FAOL USTALAR

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

      // 4. ADMIN RUXSATI

      if (url.pathname.startsWith("/api/admin/")) {
        if (!checkAdmin()) {
          return jsonResponse({
            success: false,
            error: "Ruxsat yo'q. Admin parolini tekshiring."
          }, 401);
        }
      }

      // 5. ADMIN STATISTIKASI

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

      // 6. ADMIN BUYURTMALARI

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

      // 7. USTALAR RO'YXATI

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

      // 8. USTA QO'SHISH

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

      // 9. USTANI TAHRIRLASH VA O'CHIRISH

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

      // 10. BUYURTMAGA USTA BIRIKTIRISH VA HOLATNI O'ZGARTIRISH

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

          // ADMIN TELEGRAMIGA XABAR
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

          let workerTelegramSent = false;

          try {
            workerTelegramSent = await sendTelegram(
              env.USTA24_CHAT_ID,
              workerMessage
            );
          } catch (error) {
            console.error(
              "ADMIN TELEGRAM XABAR XATOSI:",
              error
            );
          }

          // MIJOZGA USTA BIRIKTIRILGANI HAQIDA XABAR
          const customerMessage =
            "👨‍🔧 USTA 24 — SIZGA USTA BIRIKTIRILDI\n\n" +
            "🆔 Buyurtma: #" + id + "\n" +
            "🔧 Xizmat: " + order.service + "\n\n" +
            "👨‍🔧 Usta: " + workerName + "\n" +
            "📞 Usta telefoni: " + workerPhone + "\n\n" +
            "📌 Holat: Ustaga biriktirildi\n\n" +
            "Usta bilan telefon orqali bog'lanishingiz mumkin. Rahmat!";

          const customerNotified = await notifyCustomer(
            order.phone,
            customerMessage
          );

          return jsonResponse({
            success: true,
            message: "Usta buyurtmaga biriktirildi",
            orderId: id,
            worker_name: workerName,
            worker_phone: workerPhone,
            status: "Ustaga biriktirildi",
            workerTelegramSent,
            customerNotified
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

        // MIJOZGA HOLAT O'ZGARGANI HAQIDA XABAR
        const statusMessage =
          "📢 USTA 24 — BUYURTMANGIZ HOLATI YANGILANDI\n\n" +
          "🆔 Buyurtma: #" + id + "\n" +
          "🔧 Xizmat: " + order.service + "\n" +
          "📌 Yangi holat: " + data.status +
          (order.worker_name
            ? "\n\n👨‍🔧 Usta: " + order.worker_name +
              "\n📞 Usta telefoni: " + order.worker_phone
            : "") +
          "\n\nUSTA 24 xizmatidan foydalanganingiz uchun rahmat!";

        const customerNotified = await notifyCustomer(
          order.phone,
          statusMessage
        );

        return jsonResponse({
          success: true,
          message: "Buyurtma holati yangilandi",
          orderId: id,
          status: data.status,
          customerNotified
        });
      }

      // 11. TOPILMAGAN API

      if (url.pathname.startsWith("/api/")) {
        return jsonResponse({
          success: false,
          error: "API manzili topilmadi"
        }, 404);
      }

      // 12. SAYT FAYLLARI

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
