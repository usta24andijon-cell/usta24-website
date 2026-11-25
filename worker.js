
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token",
      "Cache-Control": "no-store"
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8"
        }
      });

    const body = async () => {
      try {
        return await request.json();
      } catch {
        return null;
      }
    };

    const str = (value, max = 1000) =>
      String(value ?? "").trim().slice(0, max);

    const phone = (value) => {
      let digits = String(value || "").replace(/\D/g, "");
      if (digits.startsWith("00")) digits = digits.slice(2);
      if (digits.length === 9) digits = "998" + digits;
      return digits;
    };

    const num = (value, fallback = 0) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.round(n) : fallback;
    };

    const adminOK = () => {
      const header = request.headers.get("Authorization") || "";
      return Boolean(
        env.ADMIN_PASSWORD &&
        header.startsWith("Bearer ") &&
        header.slice(7) === env.ADMIN_PASSWORD
      );
    };

    const sendTG = async (token, chatId, text, extra = {}) => {
      if (!token || !chatId) return false;

      try {
        const response = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              ...extra
            })
          }
        );

        const result = await response.json();
        return Boolean(response.ok && result.ok);
      } catch (error) {
        console.error("Telegram send error:", error);
        return false;
      }
    };

    const answerCallback = async (callback, text, alert = false) => {
      if (!env.WORKER_BOT_TOKEN || !callback?.id) return;

      try {
        await fetch(
          `https://api.telegram.org/bot${env.WORKER_BOT_TOKEN}/answerCallbackQuery`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: callback.id,
              text,
              show_alert: alert
            })
          }
        );
      } catch (error) {
        console.error("Callback answer error:", error);
      }
    };

    const adminTG = (text) =>
      sendTG(
        env.TELEGRAM_BOT_TOKEN,
        env.USTA24_CHAT_ID || env.TELEGRAM_CHAT_ID,
        text
      );

    const customerTG = (chatId, text, extra = {}) =>
      sendTG(env.CUSTOMER_BOT_TOKEN, chatId, text, extra);

    const workerTG = (chatId, text, extra = {}) =>
      sendTG(env.WORKER_BOT_TOKEN, chatId, text, extra);

    const getOrder = (id) =>
      env.DB.prepare("SELECT * FROM orders WHERE id = ? LIMIT 1")
        .bind(id)
        .first();

    const notifyCustomer = async (rawPhone, text) => {
      const p = phone(rawPhone);
      if (!p) return false;

      try {
        const customer = await env.DB.prepare(
          "SELECT chat_id FROM customer_telegram WHERE phone = ? LIMIT 1"
        ).bind(p).first();

        return customer?.chat_id
          ? customerTG(customer.chat_id, text)
          : false;
      } catch (error) {
        console.error("Customer notification error:", error);
        return false;
      }
    };

    const ensureCustomer = async (name, rawPhone, address = "") => {
      const p = phone(rawPhone);
      if (!p) return;

      await env.DB.prepare(`
        INSERT INTO customers (name, phone, address)
        VALUES (?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          name = CASE
            WHEN excluded.name <> '' THEN excluded.name
            ELSE customers.name
          END,
          address = CASE
            WHEN excluded.address <> '' THEN excluded.address
            ELSE customers.address
          END
      `).bind(
        str(name, 150),
        p,
        str(address, 300)
      ).run();
    };

    // BUYURTMANI TUGATISH VA 10% KOMISSIYA
    const completeOrder = async (id) => {
      const order = await getOrder(id);

      if (!order) {
        return { ok: false, error: "Buyurtma topilmadi" };
      }

      // Eski tugallangan buyurtmaga keyinchalik komissiya yaratmaymiz.
      if (order.status === "Tugallandi") {
        const existing = await env.DB.prepare(
          "SELECT id FROM order_finances WHERE order_id = ?"
        ).bind(id).first();

        if (existing) {
          return {
            ok: true,
            order,
            commission: 0,
            alreadyCompleted: true
          };
        }

        return {
          ok: false,
          error: "Bu buyurtma avval tugallangan. Komissiya avtomatik yaratilmaydi."
        };
      }

      const price = num(order.price, 0);

      if (price <= 0) {
        return {
          ok: false,
          error: "Buyurtma narxi kiritilmagan. Avval narx kiriting."
        };
      }

      const commission = Math.round(price * 0.10);

      // Ikkala amal birgalikda bajariladi.
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO order_finances
            (order_id, order_price, commission_rate,
             commission_amount, payment_status, payment_method)
          VALUES (?, ?, 10, ?, 'Kutilmoqda', 'Naqd')
          ON CONFLICT(order_id) DO NOTHING
        `).bind(id, price, commission),

        env.DB.prepare(`
          UPDATE orders
          SET status = 'Tugallandi'
          WHERE id = ? AND status <> 'Tugallandi'
        `).bind(id)
      ]);

      return {
        ok: true,
        order: await getOrder(id),
        commission
      };
    };

    try {
      // OPTIONS / CORS
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders
        });
      }

      // DATABASE TEKSHIRUVI
      if (path.startsWith("/api/") && !env.DB) {
        return json({
          success: false,
          error: "D1 DB sozlanmagan. Cloudflare Bindings bo'limini tekshiring."
        }, 500);
      }

      // ==================================================
      // MIJOZ TELEGRAM BOTI
      // ==================================================
      if (path === "/api/customer-telegram-webhook" && method === "POST") {
        const received = str(
          request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        );
        const expected = str(env.CUSTOMER_BOT_WEBHOOK_SECRET);

        if (!expected || received !== expected) {
          return json({ success: false, error: "Webhook ruxsati yo'q" }, 403);
        }

        const update = await body();
        const msg = update?.message;

        if (!msg?.chat?.id) {
          return json({ success: true });
        }

        const chatId = String(msg.chat.id);

        if (String(msg.text || "").startsWith("/start")) {
          await customerTG(
            chatId,
            "Assalomu alaykum! USTA 24 mijozlar botiga xush kelibsiz.\n\nBuyurtma holati haqida xabar olish uchun telefon raqamingizni tasdiqlang.",
            {
              reply_markup: {
                keyboard: [[{
                  text: "📱 Telefon raqamimni yuborish",
                  request_contact: true
                }]],
                resize_keyboard: true,
                one_time_keyboard: true
              }
            }
          );

          return json({ success: true });
        }

        if (msg.contact) {
          const contact = msg.contact;

          if (
            !msg.from ||
            !contact.user_id ||
            Number(contact.user_id) !== Number(msg.from.id)
          ) {
            await customerTG(
              chatId,
              "Iltimos, faqat o'zingizning telefon raqamingizni yuboring."
            );
            return json({ success: true });
          }

          const p = phone(contact.phone_number);

          if (p.length < 10) {
            await customerTG(chatId, "Telefon raqami noto'g'ri.");
            return json({ success: true });
          }

          const name = str(msg.from.first_name, 100);

          await env.DB.prepare(`
            INSERT INTO customer_telegram
              (phone, chat_id, customer_name)
            VALUES (?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET
              chat_id = excluded.chat_id,
              customer_name = excluded.customer_name
          `).bind(p, chatId, name).run();

          await ensureCustomer(name, p);

          await customerTG(
            chatId,
            "✅ Telefon raqamingiz tasdiqlandi! Endi USTA 24 buyurtmalaringiz haqida xabar olasiz.",
            { reply_markup: { remove_keyboard: true } }
          );
        }

        return json({ success: true });
      }

      // ==================================================
      // USTALAR TELEGRAM BOTI
      // ==================================================
      if (path === "/api/worker-telegram-webhook" && method === "POST") {
        const received = str(
          request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        );
        const expected = str(env.WORKER_BOT_WEBHOOK_SECRET);

        if (!expected || received !== expected) {
          return json({ success: false, error: "Webhook ruxsati yo'q" }, 403);
        }

        const update = await body();
        const msg = update?.message;

        // /start
        if (msg?.chat?.id && String(msg.text || "").startsWith("/start")) {
          await workerTG(
            String(msg.chat.id),
            "Assalomu alaykum! USTA 24 ustalar botiga xush kelibsiz.\n\nBuyurtmalarni olish uchun saytda ro'yxatdan o'tgan telefon raqamingizni tasdiqlang.",
            {
              reply_markup: {
                keyboard: [[{
                  text: "📱 Telefon raqamimni yuborish",
                  request_contact: true
                }]],
                resize_keyboard: true,
                one_time_keyboard: true
              }
            }
          );

          return json({ success: true });
        }

        // Telefon raqamini tasdiqlash
        if (msg?.contact) {
          const contact = msg.contact;

          if (
            !msg.from ||
            !contact.user_id ||
            Number(contact.user_id) !== Number(msg.from.id)
          ) {
            await workerTG(
              String(msg.chat.id),
              "Iltimos, faqat o'zingizning telefon raqamingizni yuboring."
            );
            return json({ success: true });
          }

          const p = phone(contact.phone_number);

          const worker = await env.DB.prepare(`
            SELECT id, name
            FROM ustalar
            WHERE phone = ? AND status = 'Faol'
            LIMIT 1
          `).bind(p).first();

          if (!worker) {
            await workerTG(
              String(msg.chat.id),
              "Bu telefon raqami faol ustalar ro'yxatida topilmadi. Administrator bilan bog'laning."
            );
            return json({ success: true });
          }

          await env.DB.prepare(`
            UPDATE ustalar
            SET telegram_chat_id = ?
            WHERE id = ?
          `).bind(String(msg.chat.id), worker.id).run();

          await workerTG(
            String(msg.chat.id),
            "✅ Telefon raqamingiz tasdiqlandi. Buyurtmalar kelganda shu bot orqali xabar olasiz.",
            { reply_markup: { remove_keyboard: true } }
          );

          return json({ success: true });
        }

        // Buyurtma tugmalari
        const callback = update?.callback_query;

        if (callback) {
          const data = String(callback.data || "");

          // accept:12, start:12, done:12
          const match = data.match(/^(accept|start|done)[:_](\d+)$/i);

          if (!match) {
            await answerCallback(callback, "Noto'g'ri buyruq", true);
            return json({ success: true });
          }

          const action = match[1].toLowerCase();
          const orderId = Number(match[2]);

          const worker = await env.DB.prepare(`
            SELECT id, name, phone
            FROM ustalar
            WHERE telegram_chat_id = ?
              AND status = 'Faol'
            LIMIT 1
          `).bind(String(callback.from.id)).first();

          const order = await getOrder(orderId);
          let result;

          if (!worker || !order) {
            result = {
              ok: false,
              error: "Usta yoki buyurtma topilmadi"
            };
          } else if (action === "accept") {
            if (
              order.status !== "Yangi" &&
              order.status !== "Ustaga biriktirildi"
            ) {
              result = {
                ok: false,
                error: "Bu buyurtma boshqa holatda"
              };
            } else {
              await env.DB.prepare(`
                UPDATE orders
                SET status = 'Qabul qilindi',
                    worker_name = ?,
                    worker_phone = ?
                WHERE id = ?
              `).bind(worker.name, worker.phone, orderId).run();

              result = { ok: true };
            }
          } else if (action === "start") {
            if (
              order.worker_phone &&
              phone(order.worker_phone) !== phone(worker.phone)
            ) {
              result = {
                ok: false,
                error: "Bu buyurtma boshqa ustaga biriktirilgan"
              };
            } else if (
              order.status !== "Qabul qilindi" &&
              order.status !== "Ustaga biriktirildi"
            ) {
              result = {
                ok: false,
                error: "Buyurtmani boshlash mumkin emas"
              };
            } else {
              await env.DB.prepare(`
                UPDATE orders
                SET status = 'Bajarilmoqda',
                    worker_name = ?,
                    worker_phone = ?
                WHERE id = ?
              `).bind(worker.name, worker.phone, orderId).run();

              result = { ok: true };
            }
          } else {
            if (
              order.worker_phone &&
              phone(order.worker_phone) !== phone(worker.phone)
            ) {
              result = {
                ok: false,
                error: "Bu buyurtma boshqa ustaga biriktirilgan"
              };
            } else if (order.status !== "Bajarilmoqda") {
              result = {
                ok: false,
                error: "Avval buyurtmani bajarishni boshlang"
              };
            } else {
              result = await completeOrder(orderId);
            }
          }

          await answerCallback(
            callback,
            result.ok ? "Buyurtma holati yangilandi" : result.error,
            !result.ok
          );

          if (result.ok) {
            const updated = await getOrder(orderId);

            await notifyCustomer(
              updated.phone,
              `USTA 24: #${orderId} buyurtmangiz holati: ${updated.status}`
            );

            await adminTG(
              `USTA 24 — Buyurtma #${orderId}\nHolati: ${updated.status}\nUsta: ${worker.name}`
            );
          }

          return json({ success: true });
        }

        return json({ success: true });
      }

      // ==================================================
      // SAYTDAN BUYURTMA
      // ==================================================
      if (path === "/api/order" && method === "POST") {
        const data = await body();

        if (!data) {
          return json({
            success: false,
            error: "Ma'lumot noto'g'ri"
          }, 400);
        }

        const name = str(data.name, 150);
        const p = phone(data.phone);
        const service = str(data.service, 200);
        const address = str(data.address, 300);
        const details = str(data.details, 2000);

        if (!name || p.length < 10 || !service || !address) {
          return json({
            success: false,
            error: "Ism, telefon, xizmat va manzilni to'liq kiriting"
          }, 400);
        }

        const inserted = await env.DB.prepare(`
          INSERT INTO orders
            (name, phone, service, address, details, status, source)
          VALUES (?, ?, ?, ?, ?, 'Yangi', 'Veb-sayt')
        `).bind(name, p, service, address, details).run();

        const orderId = inserted.meta?.last_row_id;

        await ensureCustomer(name, p, address);

        const telegramSent = await adminTG(
          `🛠 USTA 24 — YANGI BUYURTMA\n\n` +
          `Buyurtma: #${orderId || "?"}\n` +
          `Ism: ${name}\n` +
          `Telefon: ${p}\n` +
          `Xizmat: ${service}\n` +
          `Manzil: ${address}\n` +
          `Izoh: ${details || "Yo'q"}\n` +
          `Manba: Veb-sayt`
        );

        return json({
          success: true,
          message: "Buyurtma qabul qilindi",
          order_id: orderId,
          telegramSent
        }, 201);
      }

      // SAYT UCHUN FAOL USTALAR
      if (path === "/api/ustalar" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT id, name, phone, specialty, status
          FROM ustalar
          WHERE status = 'Faol'
          ORDER BY id DESC
        `).all();

        return json({
          success: true,
          ustalar: result.results || []
        });
      }

      // ==================================================
      // ADMIN API HIMOYASI
      // ==================================================
      if (path.startsWith("/api/admin/") && !adminOK()) {
        return json({
          success: false,
          error: "Admin paroli noto'g'ri"
        }, 401);
      }

      // ==================================================
      // ADMIN STATISTIKA
      // ==================================================
      if (path === "/api/admin/stats" && method === "GET") {
        const total = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM orders"
        ).first();

        const fresh = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM orders WHERE status = 'Yangi'"
        ).first();

        const progress = await env.DB.prepare(`
          SELECT COUNT(*) AS n
          FROM orders
          WHERE status IN (
            'Qabul qilindi',
            'Ustaga biriktirildi',
            'Bajarilmoqda'
          )
        `).first();

        const completed = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM orders WHERE status = 'Tugallandi'"
        ).first();

        const finance = await env.DB.prepare(`
          SELECT
            COALESCE(SUM(commission_amount), 0) AS commission_total,
            COALESCE(SUM(
              CASE WHEN payment_status = 'To''landi'
              THEN commission_amount ELSE 0 END
            ), 0) AS paid_total,
            COALESCE(SUM(
              CASE WHEN payment_status = 'Kutilmoqda'
              THEN commission_amount ELSE 0 END
            ), 0) AS pending_total
          FROM order_finances
        `).first();

        const expenses = await env.DB.prepare(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses"
        ).first();

        return json({
          success: true,
          stats: {
            total: total?.n || 0,
            new_orders: fresh?.n || 0,
            in_progress: progress?.n || 0,
            completed: completed?.n || 0,
            commission_total: finance?.commission_total || 0,
            paid_total: finance?.paid_total || 0,
            pending_total: finance?.pending_total || 0,
            expenses: expenses?.total || 0,
            profit:
              (finance?.commission_total || 0) -
              (expenses?.total || 0)
          }
        });
      }

      // ==================================================
      // BUYURTMALAR
      // ==================================================
      if (path === "/api/admin/orders" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT
            o.*,
            f.order_price AS finance_price,
            f.commission_amount,
            f.payment_status,
            f.payment_method,
            f.paid_at
          FROM orders o
          LEFT JOIN order_finances f ON f.order_id = o.id
          ORDER BY o.id DESC
        `).all();

        return json({
          success: true,
          orders: result.results || []
        });
      }

      // ADMIN YANGI BUYURTMA
      if (path === "/api/admin/orders" && method === "POST") {
        const data = await body();
        if (!data) {
          return json({ success: false, error: "Ma'lumot noto'g'ri" }, 400);
        }

        const name = str(data.name, 150);
        const p = phone(data.phone);
        const service = str(data.service, 200);
        const address = str(data.address, 300);
        const details = str(data.details, 2000);
        const source = str(data.source || "Boshqa", 50);
        const price = num(data.price, 0);

        if (!name || p.length < 10 || !service || !address) {
          return json({
            success: false,
            error: "Ism, telefon, xizmat va manzil kerak"
          }, 400);
        }

        if (price < 0) {
          return json({
            success: false,
            error: "Narx manfiy bo'lishi mumkin emas"
          }, 400);
        }

        const inserted = await env.DB.prepare(`
          INSERT INTO orders
            (name, phone, service, address, details, status, price, source)
          VALUES (?, ?, ?, ?, ?, 'Yangi', ?, ?)
        `).bind(
          name, p, service, address, details, price, source
        ).run();

        const id = inserted.meta?.last_row_id;

        await ensureCustomer(name, p, address);

        await adminTG(
          `🛠 USTA 24 — ADMIN BUYURTMASI\n` +
          `Buyurtma: #${id}\n` +
          `Mijoz: ${name}\n` +
          `Telefon: ${p}\n` +
          `Xizmat: ${service}\n` +
          `Narx: ${price.toLocaleString("uz-UZ")} so'm\n` +
          `Manba: ${source}`
        );

        return json({ success: true, order_id: id }, 201);
      }

      // BUYURTMANI TAHRIRLASH
      const orderMatch = path.match(/^\/api\/admin\/orders\/(\d+)$/);

      if (orderMatch && method === "PATCH") {
        const id = Number(orderMatch[1]);
        const data = await body();

        if (!data) {
          return json({ success: false, error: "Ma'lumot noto'g'ri" }, 400);
        }

        const old = await getOrder(id);

        if (!old) {
          return json({ success: false, error: "Buyurtma topilmadi" }, 404);
        }

        const finance = await env.DB.prepare(
          "SELECT id FROM order_finances WHERE order_id = ?"
        ).bind(id).first();

        // Narx
        if (data.price !== undefined) {
          const price = num(data.price, -1);

          if (price < 0) {
            return json({ success: false, error: "Narx noto'g'ri" }, 400);
          }

          if (old.status === "Tugallandi" || finance) {
            return json({
              success: false,
              error: "Yakunlangan buyurtma narxini o'zgartirib bo'lmaydi"
            }, 409);
          }

          await env.DB.prepare(
            "UPDATE orders SET price = ? WHERE id = ?"
          ).bind(price, id).run();
        }

        // Manba
        if (data.source !== undefined) {
          await env.DB.prepare(
            "UPDATE orders SET source = ? WHERE id = ?"
          ).bind(str(data.source, 50), id).run();
        }

        // Usta biriktirish
        if (
          data.worker_name !== undefined ||
          data.worker_phone !== undefined
        ) {
          if (old.status === "Tugallandi" || finance) {
            return json({
              success: false,
              error: "Yakunlangan buyurtmani o'zgartirib bo'lmaydi"
            }, 409);
          }

          await env.DB.prepare(`
            UPDATE orders
            SET worker_name = ?,
                worker_phone = ?,
                status = CASE
                  WHEN status = 'Yangi' THEN 'Ustaga biriktirildi'
                  ELSE status
                END
            WHERE id = ?
          `).bind(
            str(data.worker_name ?? old.worker_name, 150),
            str(data.worker_phone ?? old.worker_phone, 50),
            id
          ).run();
        }

        // Holat
        if (data.status !== undefined) {
          const allowed = [
            "Yangi",
            "Qabul qilindi",
            "Ustaga biriktirildi",
            "Bajarilmoqda",
            "Tugallandi",
            "Bekor qilindi"
          ];

          if (!allowed.includes(data.status)) {
            return json({
              success: false,
              error: "Buyurtma holati noto'g'ri"
            }, 400);
          }

          if (data.status === "Tugallandi") {
            const latest = await getOrder(id);

            if (num(latest.price, 0) <= 0) {
              return json({
                success: false,
                error: "Avval buyurtma narxini kiriting"
              }, 400);
            }

            const result = await completeOrder(id);

            if (!result.ok) {
              return json({
                success: false,
                error: result.error
              }, 400);
            }
          } else {
            if (finance || old.status === "Tugallandi") {
              return json({
                success: false,
                error: "Moliyaviy yozuv yaratilgan buyurtmani qayta ochish mumkin emas"
              }, 409);
            }

            await env.DB.prepare(
              "UPDATE orders SET status = ? WHERE id = ?"
            ).bind(data.status, id).run();
          }
        }

        const updated = await getOrder(id);

        if (updated.status !== old.status) {
          await notifyCustomer(
            updated.phone,
            `USTA 24: #${id} buyurtmangiz holati: ${updated.status}`
          );

          await adminTG(
            `USTA 24 — Buyurtma #${id}\nYangi holat: ${updated.status}`
          );
        }

        return json({ success: true, order: updated });
      }

      // ==================================================
      // USTALAR
      // ==================================================
      if (path === "/api/admin/ustalar" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM ustalar ORDER BY id DESC"
        ).all();

        return json({
          success: true,
          ustalar: result.results || []
        });
      }

      if (path === "/api/admin/ustalar" && method === "POST") {
        const data = await body();
        if (!data) {
          return json({ success: false, error: "Ma'lumot noto'g'ri" }, 400);
        }

        const name = str(data.name, 150);
        const p = phone(data.phone);
        const specialty = str(data.specialty, 200);
        const status = data.status === "Nofaol" ? "Nofaol" : "Faol";

        if (!name || p.length < 10) {
          return json({
            success: false,
            error: "Usta ismi va telefon raqami kerak"
          }, 400);
        }

        try {
          const result = await env.DB.prepare(`
            INSERT INTO ustalar (name, phone, specialty, status)
            VALUES (?, ?, ?, ?)
          `).bind(name, p, specialty, status).run();

          return json({
            success: true,
            id: result.meta?.last_row_id
          }, 201);
        } catch (error) {
          return json({
            success: false,
            error: "Usta qo'shilmadi. Telefon raqami takrorlangan bo'lishi mumkin."
          }, 409);
        }
      }

      const workerMatch = path.match(/^\/api\/admin\/ustalar\/(\d+)$/);

      if (workerMatch && method === "PATCH") {
        const id = Number(workerMatch[1]);
        const data = await body();

        if (!data) {
          return json({ success: false, error: "Ma'lumot noto'g'ri" }, 400);
        }

        const old = await env.DB.prepare(
          "SELECT * FROM ustalar WHERE id = ?"
        ).bind(id).first();

        if (!old) {
          return json({ success: false, error: "Usta topilmadi" }, 404);
        }

        const name = str(data.name ?? old.name, 150);
        const p = phone(data.phone ?? old.phone);
        const specialty = str(data.specialty ?? old.specialty, 200);
        const status =
          data.status === "Nofaol" ? "Nofaol" :
          data.status === "Faol" ? "Faol" : old.status;

        if (!name || p.length < 10) {
          return json({
            success: false,
            error: "Ism yoki telefon raqami noto'g'ri"
          }, 400);
        }

        try {
          await env.DB.prepare(`
            UPDATE ustalar
            SET name = ?, phone = ?, specialty = ?, status = ?
            WHERE id = ?
          `).bind(name, p, specialty, status, id).run();

          return json({ success: true });
        } catch (error) {
          return json({
            success: false,
            error: "Usta ma'lumotini saqlab bo'lmadi"
          }, 409);
        }
      }

      if (workerMatch && method === "DELETE") {
        const id = Number(workerMatch[1]);

        const result = await env.DB.prepare(`
          UPDATE ustalar
          SET status = 'Nofaol'
          WHERE id = ?
        `).bind(id).run();

        return json({
          success: true,
          changed: result.meta?.changes || 0
        });
      }

      // ==================================================
      // MIJOZLAR
      // ==================================================
      if (path === "/api/admin/customers" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT c.*,
            (SELECT COUNT(*) FROM orders o WHERE o.phone = c.phone)
              AS orders_count,
            (SELECT MAX(o.created_at) FROM orders o WHERE o.phone = c.phone)
              AS last_order
          FROM customers c
          ORDER BY c.id DESC
        `).all();

        return json({
          success: true,
          customers: result.results || []
        });
      }

      const customerMatch = path.match(
        /^\/api\/admin\/customers\/(\d+)\/orders$/
      );

      if (customerMatch && method === "GET") {
        const customer = await env.DB.prepare(
          "SELECT * FROM customers WHERE id = ?"
        ).bind(Number(customerMatch[1])).first();

        if (!customer) {
          return json({ success: false, error: "Mijoz topilmadi" }, 404);
        }

        const result = await env.DB.prepare(`
          SELECT * FROM orders
          WHERE phone = ?
          ORDER BY id DESC
        `).bind(customer.phone).all();

        return json({
          success: true,
          orders: result.results || []
        });
      }

      // ==================================================
      // XIZMATLAR
      // ==================================================
      if (path === "/api/admin/services" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM services ORDER BY id DESC"
        ).all();

        return json({
          success: true,
          services: result.results || []
        });
      }

      if (path === "/api/admin/services" && method === "POST") {
        const data = await body();
        const name = str(data?.name, 150);
        const description = str(data?.description, 500);

        if (!name) {
          return json({
            success: false,
            error: "Xizmat nomini kiriting"
          }, 400);
        }

        try {
          const result = await env.DB.prepare(`
            INSERT INTO services (name, description)
            VALUES (?, ?)
          `).bind(name, description).run();

          return json({
            success: true,
            id: result.meta?.last_row_id
          }, 201);
        } catch (error) {
          return json({
            success: false,
            error: "Bu xizmat avval qo'shilgan bo'lishi mumkin"
          }, 409);
        }
      }

      const serviceMatch = path.match(/^\/api\/admin\/services\/(\d+)$/);

      if (serviceMatch && method === "PATCH") {
        const id = Number(serviceMatch[1]);
        const data = await body();

        const old = await env.DB.prepare(
          "SELECT * FROM services WHERE id = ?"
        ).bind(id).first();

        if (!old) {
          return json({ success: false, error: "Xizmat topilmadi" }, 404);
        }

        await env.DB.prepare(`
          UPDATE services
          SET name = ?, description = ?, status = ?
          WHERE id = ?
        `).bind(
          str(data?.name ?? old.name, 150),
          str(data?.description ?? old.description, 500),
          data?.status === "Nofaol" ? "Nofaol" :
          data?.status === "Faol" ? "Faol" : old.status,
          id
        ).run();

        return json({ success: true });
      }

      if (serviceMatch && method === "DELETE") {
        await env.DB.prepare(`
          UPDATE services
          SET status = 'Nofaol'
          WHERE id = ?
        `).bind(Number(serviceMatch[1])).run();

        return json({ success: true });
      }

      // ==================================================
      // MOLIYA
      // ==================================================
      if (path === "/api/admin/finance" && method === "GET") {
        const commissions = await env.DB.prepare(`
          SELECT
            COALESCE(SUM(commission_amount), 0) AS total,
            COALESCE(SUM(
              CASE WHEN payment_status = 'To''landi'
              THEN commission_amount ELSE 0 END
            ), 0) AS paid,
            COALESCE(SUM(
              CASE WHEN payment_status = 'Kutilmoqda'
              THEN commission_amount ELSE 0 END
            ), 0) AS pending
          FROM order_finances
        `).first();

        const expenses = await env.DB.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS total
          FROM expenses
        `).first();

        const rows = await env.DB.prepare(`
          SELECT
            f.*,
            o.name AS customer_name,
            o.phone,
            o.service
          FROM order_finances f
          JOIN orders o ON o.id = f.order_id
          ORDER BY f.id DESC
        `).all();

        return json({
          success: true,
          summary: {
            commission: commissions?.total || 0,
            paid: commissions?.paid || 0,
            pending: commissions?.pending || 0,
            expenses: expenses?.total || 0,
            profit:
              (commissions?.total || 0) -
              (expenses?.total || 0)
          },
          finances: rows.results || []
        });
      }

      // XARAJATLAR RO'YXATI
      if (path === "/api/admin/expenses" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT * FROM expenses
          ORDER BY expense_date DESC, id DESC
        `).all();

        return json({
          success: true,
          expenses: result.results || []
        });
      }

      // YANGI XARAJAT
      if (path === "/api/admin/expenses" && method === "POST") {
        const data = await body();

        const title = str(data?.title, 200);
        const category = str(data?.category, 100);
        const amount = num(data?.amount, -1);
        const date = str(data?.expense_date, 20);
        const notes = str(data?.notes, 1000);

        if (!title || amount <= 0) {
          return json({
            success: false,
            error: "Xarajat nomi va summasini to'g'ri kiriting"
          }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO expenses
            (title, category, amount, expense_date, notes)
          VALUES (?, ?, ?, COALESCE(NULLIF(?, ''), CURRENT_DATE), ?)
        `).bind(title, category, amount, date, notes).run();

        return json({
          success: true,
          id: result.meta?.last_row_id
        }, 201);
      }

      // KOMISSIYA TO'LOVINI QAYD ETISH
      const paymentMatch = path.match(
        /^\/api\/admin\/finance\/(\d+)\/paid$/
      );

      if (paymentMatch && method === "PATCH") {
        const id = Number(paymentMatch[1]);

        const finance = await env.DB.prepare(
          "SELECT * FROM order_finances WHERE id = ?"
        ).bind(id).first();

        if (!finance) {
          return json({
            success: false,
            error: "Moliyaviy yozuv topilmadi"
          }, 404);
        }

        await env.DB.prepare(`
          UPDATE order_finances
          SET payment_status = 'To''landi',
              payment_method = 'Naqd',
              paid_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(id).run();

        return json({ success: true });
      }

      // ==================================================
      // SHARHLAR
      // ==================================================
      if (path === "/api/admin/reviews" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM reviews ORDER BY id DESC"
        ).all();

        return json({
          success: true,
          reviews: result.results || []
        });
      }

      if (path === "/api/admin/reviews" && method === "POST") {
        const data = await body();

        const name = str(data?.customer_name, 150);
        const p = phone(data?.phone);
        const rating = num(data?.rating, 0);
        const comment = str(data?.comment, 2000);

        if (!name || rating < 1 || rating > 5) {
          return json({
            success: false,
            error: "Ism va 1 dan 5 gacha baho kiriting"
          }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO reviews (customer_name, phone, rating, comment)
          VALUES (?, ?, ?, ?)
        `).bind(name, p, rating, comment).run();

        return json({
          success: true,
          id: result.meta?.last_row_id
        }, 201);
      }

      const reviewMatch = path.match(/^\/api\/admin\/reviews\/(\d+)$/);

      if (reviewMatch && method === "PATCH") {
        const id = Number(reviewMatch[1]);
        const data = await body();

        const allowed = [
          "Kutilmoqda",
          "Tasdiqlandi",
          "Rad etildi"
        ];

        if (!allowed.includes(data?.status)) {
          return json({
            success: false,
            error: "Sharh holati noto'g'ri"
          }, 400);
        }

        await env.DB.prepare(`
          UPDATE reviews SET status = ?
          WHERE id = ?
        `).bind(data.status, id).run();

        return json({ success: true });
      }

      // ==================================================
      // REKLAMA HISOBOTLARI
      // ==================================================
      if (path === "/api/admin/ads" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT * FROM ad_campaigns
          ORDER BY campaign_date DESC, id DESC
        `).all();

        return json({
          success: true,
          campaigns: result.results || []
        });
      }

      if (path === "/api/admin/ads" && method === "POST") {
        const data = await body();

        const platform = str(data?.platform, 50);
        const campaign = str(data?.campaign_name, 200);
        const spend = num(data?.spend, 0);
        const impressions = num(data?.impressions, 0);
        const clicks = num(data?.clicks, 0);
        const leads = num(data?.leads, 0);
        const date = str(data?.campaign_date, 20);
        const notes = str(data?.notes, 1000);

        if (
          !platform ||
          !campaign ||
          spend < 0 ||
          impressions < 0 ||
          clicks < 0 ||
          leads < 0
        ) {
          return json({
            success: false,
            error: "Reklama ma'lumotlarini tekshiring"
          }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO ad_campaigns
            (platform, campaign_name, spend, impressions,
             clicks, leads, campaign_date, notes)
          VALUES (?, ?, ?, ?, ?, ?,
            COALESCE(NULLIF(?, ''), CURRENT_DATE), ?)
        `).bind(
          platform,
          campaign,
          spend,
          impressions,
          clicks,
          leads,
          date,
          notes
        ).run();

        return json({
          success: true,
          id: result.meta?.last_row_id
        }, 201);
      }

      // ==================================================
      // SOZLAMALAR
      // ==================================================
      if (path === "/api/admin/settings" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT setting_key, setting_value, updated_at
          FROM app_settings
          ORDER BY setting_key
        `).all();

        return json({
          success: true,
          settings: result.results || []
        });
      }

      if (path === "/api/admin/settings" && method === "POST") {
        const data = await body();

        const key = str(data?.setting_key, 100);
        const value = str(data?.setting_value, 1000);

        const allowedKeys = [
          "business_name",
          "business_phone",
          "instagram",
          "telegram",
          "website",
          "address"
        ];

        if (!allowedKeys.includes(key)) {
          return json({
            success: false,
            error: "Bu sozlama kalitiga ruxsat berilmagan"
          }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO app_settings
            (setting_key, setting_value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = CURRENT_TIMESTAMP
        `).bind(key, value).run();

        return json({ success: true });
      }

      // TOPILMAGAN API
      if (path.startsWith("/api/")) {
        return json({
          success: false,
          error: "API yo'li topilmadi"
        }, 404);
      }

      // ==================================================
      // SAYT VA ADMIN HTML FAYLLARI
      // ==================================================
      if (env.ASSETS) {
        if (
          method === "GET" &&
          (path === "/" || path === "/admin" || path === "/admin.html")
        ) {
          const assetPath =
            path === "/" ? "/index.html" : "/admin.html";

          const assetUrl = new URL(assetPath, url.origin);

          return env.ASSETS.fetch(
            new Request(assetUrl.toString(), request)
          );
        }

        return env.ASSETS.fetch(request);
      }

      return new Response(
        "USTA24 server ishlayapti, lekin ASSETS binding sozlanmagan.",
        { status: 500, headers: corsHeaders }
      );

    } catch (error) {
      console.error("USTA24 Worker xatosi:", error);

      return json({
        success: false,
        error: "Serverda xatolik yuz berdi"
      }, 500);
    }
  }
};
