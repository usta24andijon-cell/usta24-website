
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });

const normalizePhone = (phone = "") =>
  String(phone).replace(/\D/g, "").replace(/^998/, "998");

const money = value => Math.round(Number(value) || 0);

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function telegram(token, chatId, text, extra = {}) {
  if (!token || !chatId) return null;

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
    return await response.json();
  } catch (error) {
    console.error("Telegram xatosi:", error);
    return null;
  }
}

async function answerCallback(token, callbackId, text) {
  if (!token || !callbackId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text
      })
    });
  } catch (error) {
    console.error("Callback xatosi:", error);
  }
}

const adminTelegram = (env, message) =>
  telegram(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID || env.USTA24_CHAT_ID,
    message
  );

async function notifyCustomer(env, phone, message) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;

  const customer = await env.DB.prepare(
    "SELECT chat_id FROM customer_telegram WHERE phone = ?"
  ).bind(normalized).first();

  if (customer?.chat_id) {
    await telegram(env.CUSTOMER_BOT_TOKEN, customer.chat_id, message);
  }
}

async function notifyWorker(env, workerPhone, message, keyboard) {
  const normalized = normalizePhone(workerPhone);

  const worker = await env.DB.prepare(
    "SELECT telegram_chat_id FROM ustalar WHERE phone = ? AND status = 'Faol'"
  ).bind(normalized).first();

  if (worker?.telegram_chat_id) {
    await telegram(env.WORKER_BOT_TOKEN, worker.telegram_chat_id, message, {
      reply_markup: keyboard
    });
  }
}

async function createFinance(db, orderId, price) {
  const amount = money(price);

  if (amount <= 0) {
    throw new Error("Buyurtma narxi kiritilmagan.");
  }

  const commission = Math.round(amount * 0.10);

  await db.prepare(`
    INSERT OR IGNORE INTO order_finances
    (order_id, order_price, commission_rate, commission_amount,
     payment_status, payment_method)
    VALUES (?, ?, 10, ?, 'Kutilmoqda', 'Naqd')
  `).bind(orderId, amount, commission).run();
}

function checkAdmin(request, env) {
  const password = env.ADMIN_PASSWORD;
  const auth = request.headers.get("Authorization") || "";

  return Boolean(password && auth === `Bearer ${password}`);
}

async function requireAdmin(request, env) {
  if (!checkAdmin(request, env)) {
    return json({ success: false, message: "Ruxsat yo‘q." }, 401);
  }
  return null;
}

async function handleWorkerWebhook(request, env) {
  const secret = env.WORKER_BOT_WEBHOOK_SECRET;

  if (
    secret &&
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret
  ) {
    return json({ success: false }, 401);
  }

  const update = await readBody(request);
  const message = update.message;
  const callback = update.callback_query;
  const token = env.WORKER_BOT_TOKEN;

  // Usta botni /start qilganda
  if (message?.text === "/start") {
    await telegram(
      token,
      message.chat.id,
      "Assalomu alaykum! USTA24 ustalar botiga xush kelibsiz.\n\n" +
      "Telefon raqamingizni yuborib, ro‘yxatdan o‘ting.",
      {
        reply_markup: {
          keyboard: [[{
            text: "📱 Telefon raqamni yuborish",
            request_contact: true
          }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );

    return json({ success: true });
  }

  // Ustaning telefon raqamini tekshirish
  if (message?.contact) {
    const contact = message.contact;
    const senderId = message.from?.id;

    if (contact.user_id && Number(contact.user_id) !== Number(senderId)) {
      await telegram(token, message.chat.id,
        "Iltimos, o‘zingizning telefon raqamingizni yuboring.");
      return json({ success: true });
    }

    const phone = normalizePhone(contact.phone_number);

    const worker = await env.DB.prepare(
      "SELECT id, name FROM ustalar WHERE phone = ? AND status = 'Faol'"
    ).bind(phone).first();

    if (!worker) {
      await telegram(token, message.chat.id,
        "Siz USTA24 tizimida faol usta sifatida topilmadingiz. Administrator bilan bog‘laning.");
      return json({ success: true });
    }

    await env.DB.prepare(
      "UPDATE ustalar SET telegram_chat_id = ? WHERE id = ?"
    ).bind(String(message.chat.id), worker.id).run();

    await telegram(token, message.chat.id,
      `Assalomu alaykum, ${worker.name}!\nTelegram hisobingiz USTA24 tizimiga ulandi.`);

    return json({ success: true });
  }

  // Usta buyurtma tugmalarini bosganda
  if (callback?.data) {
    const parts = callback.data.split(":");
    const action = parts[1];
    const orderId = Number(parts[2]);
    const chatId = callback.message?.chat?.id;

    if (!["accept", "start", "done"].includes(action) || !orderId) {
      await answerCallback(token, callback.id, "Noto‘g‘ri buyruq.");
      return json({ success: true });
    }

    const worker = await env.DB.prepare(
      "SELECT id, name, phone FROM ustalar WHERE telegram_chat_id = ? AND status = 'Faol'"
    ).bind(String(chatId)).first();

    if (!worker) {
      await answerCallback(token, callback.id, "Usta topilmadi.");
      return json({ success: true });
    }

    const order = await env.DB.prepare(
      "SELECT * FROM orders WHERE id = ?"
    ).bind(orderId).first();

    if (!order) {
      await answerCallback(token, callback.id, "Buyurtma topilmadi.");
      return json({ success: true });
    }

    if (normalizePhone(order.worker_phone) !== normalizePhone(worker.phone)) {
      await answerCallback(token, callback.id, "Bu buyurtma sizga biriktirilmagan.");
      return json({ success: true });
    }

    const transitions = {
      accept: {
        from: "Ustaga biriktirildi",
        to: "Qabul qilindi",
        message: "Buyurtmani qabul qildingiz."
      },
      start: {
        from: "Qabul qilindi",
        to: "Bajarilmoqda",
        message: "Buyurtma bajarilishi boshlandi."
      },
      done: {
        from: "Bajarilmoqda",
        to: "Tugallandi",
        message: "Buyurtma yakunlandi."
      }
    };

    const transition = transitions[action];

    if (order.status !== transition.from) {
      await answerCallback(token, callback.id,
        `Buyurtma holati mos emas: ${order.status}`);
      return json({ success: true });
    }

    if (action === "done" && money(order.price) <= 0) {
      await answerCallback(token, callback.id,
        "Administrator buyurtma narxini kiritishi kerak.");
      return json({ success: true });
    }

    await env.DB.prepare(
      "UPDATE orders SET status = ? WHERE id = ?"
    ).bind(transition.to, orderId).run();

    if (action === "done") {
      await createFinance(env.DB, orderId, order.price);
    }

    await answerCallback(token, callback.id, transition.message);

    const statusMessage =
      `USTA24 buyurtma #${orderId}\nHolati: ${transition.to}`;

    await adminTelegram(env, statusMessage);
    await notifyCustomer(env, order.phone, statusMessage);

    if (action === "accept") {
      await telegram(token, chatId,
        "Buyurtma qabul qilindi. Ishni boshlaganingizda tugmani bosing.",
        {
          reply_markup: {
            inline_keyboard: [[{
              text: "▶️ Ishni boshlash",
              callback_data: `w:start:${orderId}`
            }]]
          }
        }
      );
    } else if (action === "start") {
      await telegram(token, chatId,
        "Ish boshlandi. Tugatganingizda quyidagi tugmani bosing.",
        {
          reply_markup: {
            inline_keyboard: [[{
              text: "✅ Ishni tugatish",
              callback_data: `w:done:${orderId}`
            }]]
          }
        }
      );
    } else {
      await telegram(token, chatId,
        `Buyurtma tugallandi.\nBuyurtma narxi: ${money(order.price).toLocaleString("uz-UZ")} so‘m\n` +
        `USTA24 komissiyasi (10%): ${Math.round(money(order.price) * 0.1).toLocaleString("uz-UZ")} so‘m`
      );
    }

    return json({ success: true });
  }

  return json({ success: true });
}

async function handleCustomerWebhook(request, env) {
  const secret = env.CUSTOMER_BOT_WEBHOOK_SECRET;

  if (
    secret &&
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret
  ) {
    return json({ success: false }, 401);
  }

  const update = await readBody(request);
  const message = update.message;
  const token = env.CUSTOMER_BOT_TOKEN;

  if (message?.text === "/start") {
    await telegram(token, message.chat.id,
      "Assalomu alaykum! USTA24 mijozlar botiga xush kelibsiz.\n\n" +
      "Buyurtma holati haqida xabar olish uchun telefon raqamingizni yuboring.",
      {
        reply_markup: {
          keyboard: [[{
            text: "📱 Telefon raqamni yuborish",
            request_contact: true
          }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
    return json({ success: true });
  }

  if (message?.contact) {
    const contact = message.contact;

    if (contact.user_id && Number(contact.user_id) !== Number(message.from?.id)) {
      await telegram(token, message.chat.id,
        "Iltimos, o‘zingizning telefon raqamingizni yuboring.");
      return json({ success: true });
    }

    const phone = normalizePhone(contact.phone_number);
    const name = message.from?.first_name || "Mijoz";

    await env.DB.prepare(`
      INSERT INTO customer_telegram (phone, chat_id, customer_name)
      VALUES (?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        chat_id = excluded.chat_id,
        customer_name = excluded.customer_name
    `).bind(phone, String(message.chat.id), name).run();

    await telegram(token, message.chat.id,
      "Rahmat! Telegram hisobingiz USTA24 tizimiga ulandi. Buyurtmangiz holati haqida xabar beramiz.");
  }

  return json({ success: true });
}

async function handleOrder(request, env) {
  const body = await readBody(request);

  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const service = String(body.service || "").trim();
  const address = String(body.address || "").trim();
  const details = String(body.details || "").trim();

  if (!name || !phone || !service || !address) {
    return json({
      success: false,
      message: "Ism, telefon, xizmat va manzilni kiriting."
    }, 400);
  }

  const result = await env.DB.prepare(`
    INSERT INTO orders
    (name, phone, service, address, details, status, source)
    VALUES (?, ?, ?, ?, ?, 'Yangi', 'Veb-sayt')
  `).bind(name, phone, service, address, details).run();

  const orderId = result.meta?.last_row_id;

  await adminTelegram(env,
    `🛠 USTA24 — YANGI BUYURTMA\n\n` +
    `Buyurtma: #${orderId || ""}\n` +
    `Ism: ${name}\nTelefon: ${phone}\n` +
    `Xizmat: ${service}\nManzil: ${address}\n` +
    `Izoh: ${details || "Yo‘q"}\nManba: Veb-sayt`
  );

  return json({
    success: true,
    message: "Buyurtmangiz qabul qilindi.",
    order_id: orderId
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method;

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (!env.DB) {
        return json({ success: false, message: "DB binding topilmadi." }, 500);
      }

      // Sayt fayllari
      if (path === "/" || path === "/admin" || path === "/admin.html") {
        if (!env.ASSETS) {
          return json({ success: false, message: "ASSETS binding topilmadi." }, 500);
        }
        const assetPath = path === "/" ? "/index.html" : "/admin.html";
        return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
      }

      // Telegram webhooklar
      if (path === "/api/worker-telegram-webhook" && method === "POST") {
        return await handleWorkerWebhook(request, env);
      }

      if (path === "/api/customer-telegram-webhook" && method === "POST") {
        return await handleCustomerWebhook(request, env);
      }

      // Mijozning saytdagi buyurtmasi
      if (path === "/api/order" && method === "POST") {
        return await handleOrder(request, env);
      }

      // Saytda faol ustalar ro‘yxati
      if (path === "/api/ustalar" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT id, name, specialty FROM ustalar WHERE status = 'Faol' ORDER BY name"
        ).all();
        return json({ success: true, ustalar: result.results || [] });
      }

      // Admin API uchun parol tekshiruvi
      if (path.startsWith("/api/admin")) {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
      }

      // Statistikalar
      if (path === "/api/admin/stats" && method === "GET") {
        const stats = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'Yangi' THEN 1 ELSE 0 END) AS new_orders,
            SUM(CASE WHEN status IN ('Qabul qilindi','Bajarilmoqda','Ustaga biriktirildi') THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN status = 'Tugallandi' THEN 1 ELSE 0 END) AS completed
          FROM orders
        `).first();

        const finance = await env.DB.prepare(`
          SELECT
            COALESCE(SUM(commission_amount), 0) AS commission,
            COALESCE(SUM(CASE WHEN payment_status = 'To''landi' THEN commission_amount ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN payment_status = 'Kutilmoqda' THEN commission_amount ELSE 0 END), 0) AS pending
          FROM order_finances
        `).first();

        const expenses = await env.DB.prepare(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses"
        ).first();

        return json({
          success: true,
          stats: {
            total: stats?.total || 0,
            new_orders: stats?.new_orders || 0,
            in_progress: stats?.in_progress || 0,
            completed: stats?.completed || 0,
            commission: finance?.commission || 0,
            paid_commission: finance?.paid || 0,
            pending_commission: finance?.pending || 0,
            expenses: expenses?.total || 0,
            profit: (finance?.paid || 0) - (expenses?.total || 0)
          }
        });
      }

      // Buyurtmalar ro‘yxati
      if (path === "/api/admin/orders" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM orders ORDER BY id DESC"
        ).all();
        return json({ success: true, orders: result.results || [] });
      }

      // Admin orqali yangi buyurtma
      if (path === "/api/admin/orders" && method === "POST") {
        const body = await readBody(request);
        const name = String(body.name || "").trim();
        const phone = String(body.phone || "").trim();
        const service = String(body.service || "").trim();
        const address = String(body.address || "").trim();
        const details = String(body.details || "").trim();
        const source = String(body.source || "Boshqa").trim();
        const price = money(body.price);

        if (!name || !phone || !service || !address) {
          return json({ success: false, message: "Majburiy maydonlarni to‘ldiring." }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO orders
          (name, phone, service, address, details, status, source, price)
          VALUES (?, ?, ?, ?, ?, 'Yangi', ?, ?)
        `).bind(name, phone, service, address, details, source, price).run();

        const id = result.meta?.last_row_id;

        await adminTelegram(env,
          `🛠 YANGI BUYURTMA #${id}\n${name}\n${phone}\n${service}\n${address}\nManba: ${source}`
        );

        return json({ success: true, id });
      }

      // Buyurtma holati, narxi va usta biriktirish
      const orderMatch = path.match(/^\/api\/admin\/orders\/(\d+)$/);

      if (orderMatch && method === "PATCH") {
        const id = Number(orderMatch[1]);
        const body = await readBody(request);
        const order = await env.DB.prepare(
          "SELECT * FROM orders WHERE id = ?"
        ).bind(id).first();

        if (!order) return json({ success: false, message: "Buyurtma topilmadi." }, 404);

        if (body.price !== undefined) {
          const existingFinance = await env.DB.prepare(
            "SELECT id FROM order_finances WHERE order_id = ?"
          ).bind(id).first();

          if (existingFinance) {
            return json({
              success: false,
              message: "Komissiya hisoblangan buyurtma narxini o‘zgartirib bo‘lmaydi."
            }, 400);
          }

          await env.DB.prepare(
            "UPDATE orders SET price = ? WHERE id = ?"
          ).bind(money(body.price), id).run();
        }

        if (body.status) {
          const allowed = [
            "Yangi", "Qabul qilindi", "Ustaga biriktirildi",
            "Bajarilmoqda", "Tugallandi", "Bekor qilindi"
          ];

          if (!allowed.includes(body.status)) {
            return json({ success: false, message: "Noto‘g‘ri status." }, 400);
          }

          const price = body.price !== undefined ? money(body.price) : money(order.price);

          if (body.status === "Tugallandi") {
            if (price <= 0) {
              return json({ success: false, message: "Avval buyurtma narxini kiriting." }, 400);
            }

            await env.DB.prepare(
              "UPDATE orders SET status = ?, price = ? WHERE id = ?"
            ).bind(body.status, price, id).run();

            await createFinance(env.DB, id, price);
          } else {
            await env.DB.prepare(
              "UPDATE orders SET status = ? WHERE id = ?"
            ).bind(body.status, id).run();
          }

          await notifyCustomer(env, order.phone,
            `USTA24 buyurtma #${id}\nYangi holat: ${body.status}`);
        }

        if (body.worker_name !== undefined || body.worker_phone !== undefined) {
          const workerName = String(body.worker_name || "").trim();
          const workerPhone = String(body.worker_phone || "").trim();

          await env.DB.prepare(`
            UPDATE orders
            SET worker_name = ?, worker_phone = ?, status = 'Ustaga biriktirildi'
            WHERE id = ?
          `).bind(workerName, workerPhone, id).run();

          if (workerPhone) {
            await notifyWorker(env, workerPhone,
              `🛠 Yangi buyurtma #${id}\n` +
              `Mijoz: ${order.name}\nTelefon: ${order.phone}\n` +
              `Xizmat: ${order.service}\nManzil: ${order.address}\n` +
              `Izoh: ${order.details || "Yo‘q"}\n` +
              `Buyurtmani qabul qilish uchun tugmani bosing.`,
              {
                inline_keyboard: [[{
                  text: "✅ Buyurtmani qabul qilish",
                  callback_data: `w:accept:${id}`
                }]]
              }
            );
          }
        }

        await adminTelegram(env, `Buyurtma #${id} yangilandi.`);
        return json({ success: true, message: "Buyurtma yangilandi." });
      }

      // Ustalar
      if (path === "/api/admin/ustalar" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM ustalar ORDER BY id DESC"
        ).all();
        return json({ success: true, ustalar: result.results || [] });
      }

      if (path === "/api/admin/ustalar" && method === "POST") {
        const body = await readBody(request);

        if (!body.name || !body.phone) {
          return json({ success: false, message: "Usta ismi va telefoni kerak." }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO ustalar (name, phone, specialty, status)
          VALUES (?, ?, ?, ?)
        `).bind(
          String(body.name).trim(),
          normalizePhone(body.phone),
          body.specialty || "",
          body.status || "Faol"
        ).run();

        return json({ success: true, message: "Usta qo‘shildi." });
      }

      const workerMatch = path.match(/^\/api\/admin\/ustalar\/(\d+)$/);

      if (workerMatch && method === "PATCH") {
        const id = Number(workerMatch[1]);
        const body = await readBody(request);

        const worker = await env.DB.prepare(
          "SELECT * FROM ustalar WHERE id = ?"
        ).bind(id).first();

        if (!worker) return json({ success: false, message: "Usta topilmadi." }, 404);

        await env.DB.prepare(`
          UPDATE ustalar
          SET name = ?, phone = ?, specialty = ?, status = ?
          WHERE id = ?
        `).bind(
          body.name ?? worker.name,
          body.phone ? normalizePhone(body.phone) : worker.phone,
          body.specialty ?? worker.specialty,
          body.status ?? worker.status,
          id
        ).run();

        return json({ success: true, message: "Usta yangilandi." });
      }

      if (workerMatch && method === "DELETE") {
        await env.DB.prepare(
          "DELETE FROM ustalar WHERE id = ?"
        ).bind(Number(workerMatch[1])).run();

        return json({ success: true });
      }

      // Mijozlar ro‘yxati
      if (path === "/api/admin/customers" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT
            c.*,
            (SELECT COUNT(*) FROM orders o
             WHERE REPLACE(REPLACE(REPLACE(REPLACE(o.phone, '+', ''), ' ', ''), '-', ''), '(', '') = c.phone
            ) AS order_count
          FROM customers c
          ORDER BY c.id DESC
        `).all();

        return json({ success: true, customers: result.results || [] });
      }

      const customerMatch = path.match(/^\/api\/admin\/customers\/(\d+)$/);

      if (customerMatch && method === "GET") {
        const id = Number(customerMatch[1]);
        const customer = await env.DB.prepare(
          "SELECT * FROM customers WHERE id = ?"
        ).bind(id).first();

        if (!customer) return json({ success: false, message: "Mijoz topilmadi." }, 404);

        const history = await env.DB.prepare(`
          SELECT * FROM orders
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', '') = ?
          ORDER BY id DESC
        `).bind(customer.phone).all();

        return json({
          success: true,
          customer,
          orders: history.results || []
        });
      }

      if (customerMatch && method === "PATCH") {
        const id = Number(customerMatch[1]);
        const body = await readBody(request);

        await env.DB.prepare(`
          UPDATE customers
          SET name = COALESCE(?, name),
              address = COALESCE(?, address),
              notes = COALESCE(?, notes)
          WHERE id = ?
        `).bind(body.name ?? null, body.address ?? null, body.notes ?? null, id).run();

        return json({ success: true });
      }

      // Xizmatlar
      if (path === "/api/admin/services" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM services ORDER BY id DESC"
        ).all();
        return json({ success: true, services: result.results || [] });
      }

      if (path === "/api/admin/services" && method === "POST") {
        const body = await readBody(request);

        if (!body.name) {
          return json({ success: false, message: "Xizmat nomini kiriting." }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO services (name, description, status)
          VALUES (?, ?, ?)
        `).bind(body.name, body.description || "", body.status || "Faol").run();

        return json({ success: true });
      }

      const serviceMatch = path.match(/^\/api\/admin\/services\/(\d+)$/);

      if (serviceMatch && method === "PATCH") {
        const body = await readBody(request);
        const current = await env.DB.prepare(
          "SELECT * FROM services WHERE id = ?"
        ).bind(Number(serviceMatch[1])).first();

        if (!current) return json({ success: false, message: "Xizmat topilmadi." }, 404);

        await env.DB.prepare(`
          UPDATE services SET name = ?, description = ?, status = ? WHERE id = ?
        `).bind(
          body.name ?? current.name,
          body.description ?? current.description,
          body.status ?? current.status,
          Number(serviceMatch[1])
        ).run();

        return json({ success: true });
      }

      if (serviceMatch && method === "DELETE") {
        await env.DB.prepare(
          "DELETE FROM services WHERE id = ?"
        ).bind(Number(serviceMatch[1])).run();

        return json({ success: true });
      }

      // Xarajatlar
      if (path === "/api/admin/expenses" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM expenses ORDER BY expense_date DESC, id DESC"
        ).all();

        return json({ success: true, expenses: result.results || [] });
      }

      if (path === "/api/admin/expenses" && method === "POST") {
        const body = await readBody(request);
        const amount = money(body.amount);

        if (!body.title || amount <= 0) {
          return json({ success: false, message: "Xarajat nomi va summasini kiriting." }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO expenses (title, category, amount, expense_date, notes)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          body.title,
          body.category || "",
          amount,
          body.expense_date || null,
          body.notes || ""
        ).run();

        return json({ success: true });
      }

      // Moliya va komissiyalar
      if (path === "/api/admin/finance" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT f.*, o.name AS customer_name, o.phone, o.service,
                 o.worker_name, o.status AS order_status
          FROM order_finances f
          LEFT JOIN orders o ON o.id = f.order_id
          ORDER BY f.id DESC
        `).all();

        const totals = await env.DB.prepare(`
          SELECT
            COALESCE(SUM(commission_amount), 0) AS total_commission,
            COALESCE(SUM(CASE WHEN payment_status = 'To''landi' THEN commission_amount ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN payment_status = 'Kutilmoqda' THEN commission_amount ELSE 0 END), 0) AS pending
          FROM order_finances
        `).first();

        return json({
          success: true,
          finances: result.results || [],
          totals: totals || {}
        });
      }

      const financeMatch = path.match(/^\/api\/admin\/finance\/(\d+)$/);

      if (financeMatch && method === "PATCH") {
        const body = await readBody(request);
        const paymentStatus = body.payment_status;

        if (!["Kutilmoqda", "To'landi"].includes(paymentStatus)) {
          return json({ success: false, message: "To‘lov holati noto‘g‘ri." }, 400);
        }

        await env.DB.prepare(`
          UPDATE order_finances
          SET payment_status = ?,
              payment_method = ?,
              paid_at = CASE WHEN ? = 'To''landi' THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE id = ?
        `).bind(
          paymentStatus,
          body.payment_method || "Naqd",
          paymentStatus,
          Number(financeMatch[1])
        ).run();

        return json({ success: true });
      }

      // Sharhlar
      if (path === "/api/admin/reviews" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM reviews ORDER BY id DESC"
        ).all();
        return json({ success: true, reviews: result.results || [] });
      }

      if (path === "/api/admin/reviews" && method === "POST") {
        const body = await readBody(request);
        const rating = Number(body.rating);

        if (!body.customer_name || rating < 1 || rating > 5) {
          return json({ success: false, message: "Ism va 1–5 oralig‘idagi baho kerak." }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO reviews (customer_name, phone, rating, comment, status)
          VALUES (?, ?, ?, ?, 'Kutilmoqda')
        `).bind(
          body.customer_name,
          body.phone || "",
          rating,
          body.comment || ""
        ).run();

        return json({ success: true });
      }

      const reviewMatch = path.match(/^\/api\/admin\/reviews\/(\d+)$/);

      if (reviewMatch && method === "PATCH") {
        const body = await readBody(request);
        await env.DB.prepare(
          "UPDATE reviews SET status = ? WHERE id = ?"
        ).bind(body.status || "Tasdiqlandi", Number(reviewMatch[1])).run();

        return json({ success: true });
      }

      // Reklama natijalari
      if (path === "/api/admin/advertising" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM ad_campaigns ORDER BY campaign_date DESC, id DESC"
        ).all();

        return json({ success: true, campaigns: result.results || [] });
      }

      if (path === "/api/admin/advertising" && method === "POST") {
        const body = await readBody(request);

        if (!body.platform || !body.campaign_name) {
          return json({ success: false, message: "Platforma va kampaniya nomini kiriting." }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO ad_campaigns
          (platform, campaign_name, spend, impressions, clicks, leads, campaign_date, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          body.platform,
          body.campaign_name,
          money(body.spend),
          money(body.impressions),
          money(body.clicks),
          money(body.leads),
          body.campaign_date || null,
          body.notes || ""
        ).run();

        return json({ success: true });
      }

      const adMatch = path.match(/^\/api\/admin\/advertising\/(\d+)$/);

      if (adMatch && method === "PATCH") {
        const body = await readBody(request);
        const current = await env.DB.prepare(
          "SELECT * FROM ad_campaigns WHERE id = ?"
        ).bind(Number(adMatch[1])).first();

        if (!current) return json({ success: false, message: "Kampaniya topilmadi." }, 404);

        await env.DB.prepare(`
          UPDATE ad_campaigns
          SET platform = ?, campaign_name = ?, spend = ?,
              impressions = ?, clicks = ?, leads = ?,
              campaign_date = ?, notes = ?
          WHERE id = ?
        `).bind(
          body.platform ?? current.platform,
          body.campaign_name ?? current.campaign_name,
          body.spend !== undefined ? money(body.spend) : current.spend,
          body.impressions !== undefined ? money(body.impressions) : current.impressions,
          body.clicks !== undefined ? money(body.clicks) : current.clicks,
          body.leads !== undefined ? money(body.leads) : current.leads,
          body.campaign_date ?? current.campaign_date,
          body.notes ?? current.notes,
          Number(adMatch[1])
        ).run();

        return json({ success: true });
      }

      // Sozlamalar
      if (path === "/api/admin/settings" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT setting_key, setting_value FROM app_settings"
        ).all();

        const settings = {};
        for (const row of result.results || []) {
          settings[row.setting_key] = row.setting_value;
        }

        return json({ success: true, settings });
      }

      if (path === "/api/admin/settings" && method === "POST") {
        const body = await readBody(request);
        const settings = body.settings || body;

        for (const [key, value] of Object.entries(settings)) {
          if (typeof value === "object" && value !== null) continue;

          await env.DB.prepare(`
            INSERT INTO app_settings (setting_key, setting_value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(setting_key) DO UPDATE SET
              setting_value = excluded.setting_value,
              updated_at = CURRENT_TIMESTAMP
          `).bind(String(key), String(value ?? "")).run();
        }

        return json({
          success: true,
          message: "Sozlamalar saqlandi."
        });
      }

      // Noma’lum API manzili
      if (path.startsWith("/api/")) {
        return json({ success: false, message: "API manzili topilmadi." }, 404);
      }

      // Boshqa sayt fayllari
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({ success: false, message: "Sahifa topilmadi." }, 404);

    } catch (error) {
      console.error("SERVER ERROR:", error);
      return json({
        success: false,
        message: "Serverda xatolik yuz berdi.",
        error: error.message
      }, 500);
    }
  }
};
