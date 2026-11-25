export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
    const body = async () => { try { return await request.json(); } catch { return null; } };
    const adminOK = () => {
      const h = request.headers.get("Authorization") || "";
      return Boolean(env.ADMIN_PASSWORD && h.startsWith("Bearer ") && h.slice(7) === env.ADMIN_PASSWORD);
    };
    const str = (v, max = 1000) => String(v ?? "").trim().slice(0, max);
    const phone = v => {
      let d = String(v || "").replace(/\D/g, "");
      if (d.startsWith("00")) d = d.slice(2);
      if (d.length === 9) d = "998" + d;
      return d;
    };
    const num = (v, fallback = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : fallback;
    };
    const sendTG = async (token, chatId, text, extra = {}) => {
      if (!token || !chatId) return false;
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, ...extra })
        });
        const j = await r.json();
        return Boolean(r.ok && j.ok);
      } catch (e) { console.error("Telegram send error", e); return false; }
    };
    const adminTG = (chatId, text, extra) => sendTG(env.TELEGRAM_BOT_TOKEN, chatId, text, extra);
    const customerTG = (chatId, text, extra) => sendTG(env.CUSTOMER_BOT_TOKEN, chatId, text, extra);
    const workerTG = (chatId, text, extra) => sendTG(env.WORKER_BOT_TOKEN, chatId, text, extra);
    const notifyCustomer = async (rawPhone, text) => {
      const p = phone(rawPhone);
      if (!p || !env.DB) return false;
      try {
        const c = await env.DB.prepare("SELECT chat_id FROM customer_telegram WHERE phone = ? LIMIT 1").bind(p).first();
        return c?.chat_id ? customerTG(c.chat_id, text) : false;
      } catch (e) { console.error("Customer lookup error", e); return false; }
    };
    const notifyAdmin = (text) => adminTG(env.USTA24_CHAT_ID || env.TELEGRAM_CHAT_ID, text);
    const getOrder = id => env.DB.prepare("SELECT * FROM orders WHERE id = ? LIMIT 1").bind(id).first();

    // A completed order must have a price. UNIQUE(order_id) prevents duplicate commission rows.
    const completeOrder = async (id) => {
      const order = await getOrder(id);
      if (!order) return { ok: false, error: "Buyurtma topilmadi" };
      const price = num(order.price, 0);
      if (price <= 0) return { ok: false, error: "Buyurtma narxi kiritilmagan. Avval narx kiriting." };
      const commission = Math.round(price * 0.10);
      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO order_finances
          (order_id, order_price, commission_rate, commission_amount, payment_status, payment_method)
          VALUES (?, ?, 10, ?, 'Kutilmoqda', 'Naqd')`).bind(id, price, commission),
        env.DB.prepare("UPDATE orders SET status = 'Tugallandi' WHERE id = ?").bind(id)
      ]);
      return { ok: true, order: await getOrder(id), commission };
    };

    const ensureCustomer = async (name, rawPhone, address = "") => {
      const p = phone(rawPhone);
      if (!p) return;
      await env.DB.prepare(`INSERT INTO customers (name, phone, address)
        VALUES (?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE customers.name END,
          address = CASE WHEN excluded.address <> '' THEN excluded.address ELSE customers.address END`)
        .bind(str(name, 150), p, str(address, 300)).run();
    };

    try {
      if (!env.DB && path.startsWith("/api/")) return json({ success: false, error: "D1 DB sozlanmagan" }, 500);

      // CUSTOMER TELEGRAM WEBHOOK
      if (path === "/api/customer-telegram-webhook" && method === "POST") {
        const received = str(request.headers.get("X-Telegram-Bot-Api-Secret-Token"));
        const expected = str(env.CUSTOMER_BOT_WEBHOOK_SECRET);
        if (!expected || received !== expected) return json({ success: false, error: "Webhook ruxsati yo'q" }, 403);
        const update = await body();
        const msg = update?.message;
        if (!msg?.chat?.id) return json({ success: true });
        const chatId = String(msg.chat.id);
        if (String(msg.text || "").startsWith("/start")) {
          await customerTG(chatId, "Assalomu alaykum! USTA 24 mijozlar botiga xush kelibsiz.\n\nBuyurtma holati haqida xabar olish uchun telefon raqamingizni tasdiqlang.", {
            reply_markup: { keyboard: [[{ text: "📱 Telefon raqamimni yuborish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
          });
          return json({ success: true });
        }
        if (msg.contact) {
          const c = msg.contact;
          if (!msg.from || !c.user_id || Number(c.user_id) !== Number(msg.from.id)) {
            await customerTG(chatId, "Iltimos, faqat o'zingizning telefon raqamingizni yuboring.");
            return json({ success: true });
          }
          const p = phone(c.phone_number);
          if (p.length < 10) { await customerTG(chatId, "Telefon raqami noto'g'ri."); return json({ success: true }); }
          await env.DB.prepare(`INSERT INTO customer_telegram (phone, chat_id, customer_name) VALUES (?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET chat_id = excluded.chat_id, customer_name = excluded.customer_name`)
            .bind(p, chatId, str(msg.from.first_name, 100)).run();
          await ensureCustomer(str(msg.from.first_name, 100), p);
          await customerTG(chatId, "✅ Telefon raqamingiz tasdiqlandi! Endi USTA 24 buyurtmalaringiz haqida xabar olasiz.", { reply_markup: { remove_keyboard: true } });
        }
        return json({ success: true });
      }

      // WORKER TELEGRAM WEBHOOK
      if (path === "/api/worker-telegram-webhook" && method === "POST") {
        const received = str(request.headers.get("X-Telegram-Bot-Api-Secret-Token"));
        const expected = str(env.WORKER_BOT_WEBHOOK_SECRET);
        if (!expected || received !== expected) return json({ success: false, error: "Webhook ruxsati yo'q" }, 403);
        const update = await body();
        const msg = update?.message;
        if (msg?.chat?.id && String(msg.text || "").startsWith("/start")) {
          await workerTG(String(msg.chat.id), "Assalomu alaykum! USTA 24 ustalar botiga xush kelibsiz.\n\nBuyurtmalarni olish uchun saytda ro'yxatdan o'tgan telefon raqamingizni tasdiqlang.", {
            reply_markup: { keyboard: [[{ text: "📱 Telefon raqamimni yuborish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
          });
          return json({ success: true });
        }
        if (msg?.chat?.id && msg.contact) {
          if (!msg.from || !msg.contact.user_id || Number(msg.contact.user_id) !== Number(msg.from.id)) {
            await workerTG(String(msg.chat.id), "Iltimos, faqat o'zingizning telefon raqamingizni yuboring.");
            return json({ success: true });
          }
          const p = phone(msg.contact.phone_number);
          const list = await env.DB.prepare("SELECT id, name, phone FROM ustalar WHERE status = 'Faol'").all();
          const w = (list.results || []).find(x => phone(x.phone) === p);
          if (!w) { await workerTG(String(msg.chat.id), "❌ Telefon raqamingiz faol ustalar ro'yxatidan topilmadi. Admin bilan bog'laning."); return json({ success: true }); }
          await env.DB.prepare("UPDATE ustalar SET telegram_chat_id = ? WHERE id = ?").bind(String(msg.chat.id), w.id).run();
          await workerTG(String(msg.chat.id), `✅ Telefon tasdiqlandi!\n👨‍🔧 Usta: ${w.name}\n📞 ${w.phone}\n\nBuyurtmalar shu botga keladi.`, { reply_markup: { remove_keyboard: true } });
          return json({ success: true });
        }
        const cb = update?.callback_query;
        if (cb?.id && cb?.from?.id && cb?.data) {
          const parts = String(cb.data).split(":");
          const action = parts[1];
          const id = Number(parts[2]);
          const statusMap = { accept: "Qabul qilindi", start: "Bajarilmoqda", done: "Tugallandi" };
          const answer = async text => {
            if (!env.WORKER_BOT_TOKEN) return;
            try {
              await fetch(`https://api.telegram.org/bot${env.WORKER_BOT_TOKEN}/answerCallbackQuery`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ callback_query_id: cb.id, text, show_alert: false })
              });
            } catch (e) { console.error("Telegram callback answer error", e); }
          };
          if (parts.length !== 3 || parts[0] !== "w" || !Number.isInteger(id) || id < 1 || !statusMap[action]) { await answer("Buyruq noto'g'ri."); return json({ success: true }); }
          const worker = await env.DB.prepare("SELECT id, name, phone FROM ustalar WHERE telegram_chat_id = ? AND status = 'Faol' LIMIT 1").bind(String(cb.from.id)).first();
          if (!worker) { await answer("Siz faol usta sifatida topilmadingiz."); return json({ success: true }); }
          const order = await getOrder(id);
          if (!order || !order.worker_phone || phone(order.worker_phone) !== phone(worker.phone)) { await answer("Bu buyurtma sizga biriktirilmagan."); return json({ success: true }); }
          const allowed = { accept: ["Ustaga biriktirildi"], start: ["Qabul qilindi"], done: ["Bajarilmoqda"] };
          if (!allowed[action].includes(str(order.status))) { await answer("Buyurtma holati o'zgargan yoki bu amal mumkin emas."); return json({ success: true }); }
          if (action === "done") {
            const completed = await completeOrder(id);
            if (!completed.ok) { await answer(completed.error); await workerTG(String(cb.from.id), `⚠️ ${completed.error}\nAdmin buyurtma narxini kiritishi kerak.`); return json({ success: true }); }
          } else {
            await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(statusMap[action], id).run();
          }
          await answer("Holat yangilandi: " + statusMap[action]);
          const next = { accept: [[{ text: "🚧 Ishni boshlash", callback_data: `w:start:${id}` }]], start: [[{ text: "🏁 Ish tugadi", callback_data: `w:done:${id}` }]], done: [] };
          if (cb.message?.chat?.id && cb.message?.message_id) {
            try { await fetch(`https://api.telegram.org/bot${env.WORKER_BOT_TOKEN}/editMessageReplyMarkup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: next[action] } }) }); } catch (e) { console.error(e); }
          }
          await notifyCustomer(order.phone, `📢 USTA 24 — BUYURTMANGIZ HOLATI YANGILANDI\n\n🆔 Buyurtma: #${id}\n🔧 Xizmat: ${order.service}\n📌 Holat: ${statusMap[action]}\n👨‍🔧 Usta: ${worker.name}`);
          await notifyAdmin(`👨‍🔧 USTA BUYURTMA HOLATINI O'ZGARTIRDI\n🆔 #${id}\n👨‍🔧 ${worker.name}\n📌 ${statusMap[action]}`);
          await workerTG(String(cb.from.id), `✅ Buyurtma #${id} holati: ${statusMap[action]}`);
          return json({ success: true, status: statusMap[action] });
        }
        return json({ success: true });
      }

      // PUBLIC ORDER FORM
      if (path === "/api/order" && method === "POST") {
        const d = await body();
        if (!d) return json({ success: false, error: "Ma'lumot noto'g'ri" }, 400);
        const name = str(d.name, 150), rawPhone = str(d.phone, 40), service = str(d.service, 150), address = str(d.address, 300), details = str(d.details, 2000);
        if (!name || !rawPhone || !service || !address) return json({ success: false, error: "Ism, telefon, xizmat va manzil majburiy" }, 400);
        const saved = await env.DB.prepare(`INSERT INTO orders (name, phone, service, address, details, status, created_at, source)
          VALUES (?, ?, ?, ?, ?, 'Yangi', datetime('now'), 'Veb-sayt')`).bind(name, rawPhone, service, address, details).run();
        const id = saved.meta?.last_row_id;
        await ensureCustomer(name, rawPhone, address);
        const tg = await notifyAdmin(`🆕 USTA 24 — YANGI BUYURTMA\n\n🆔 #${id}\n👤 ${name}\n📞 ${rawPhone}\n🔧 ${service}\n📍 ${address}\n📝 ${details || "Yo'q"}\n📌 Yangi\n🌐 Manba: Veb-sayt`);
        const customerNotified = await notifyCustomer(rawPhone, `✅ USTA 24 — BUYURTMANGIZ QABUL QILINDI\n🆔 #${id}\n🔧 ${service}\n📌 Yangi`);
        return json({ success: true, message: "Buyurtma saqlandi", orderId: id, telegramSent: tg, customerNotified });
      }

      // PUBLIC SITE CONTENT, GALLERY AND REVIEWS
      if (path === "/api/site-content" && method === "GET") {
        const r = await env.DB.prepare("SELECT content_key,content_value FROM site_content").all();
        return json({success:true,content:Object.fromEntries((r.results||[]).map(x=>[x.content_key,x.content_value]))});
      }
      if (path === "/api/gallery" && method === "GET") {
        const r = await env.DB.prepare("SELECT id,title,description,image_url,category,created_at FROM work_gallery ORDER BY id DESC LIMIT 60").all();
        return json({success:true,items:r.results||[]});
      }
      if (path === "/api/reviews" && method === "GET") {
        const r = await env.DB.prepare("SELECT id,customer_name,rating,comment FROM reviews WHERE status='Tasdiqlandi' ORDER BY id DESC LIMIT 30").all();
        return json({success:true,reviews:r.results||[]});
      }
      if (path === "/api/reviews" && method === "POST") {
        const d=await body(), name=str(d?.customer_name,150), p=str(d?.phone,40), rating=num(d?.rating,0), comment=str(d?.comment,2000);
        if(!name || rating<1 || rating>5 || comment.length<5) return json({success:false,error:"Ism, 1–5 baho va kamida 5 belgili izoh kiriting"},400);
        const r=await env.DB.prepare("INSERT INTO reviews(customer_name,phone,rating,comment,status) VALUES(?,?,?,?,'Kutilmoqda')").bind(name,p,rating,comment).run();
        await notifyAdmin(`⭐ Yangi mijoz izohi (#${r.meta?.last_row_id})\n${name} — ${rating}/5\n${comment}`);
        return json({success:true,message:"Izohingiz moderator tasdig'idan so'ng saytda ko'rinadi"});
      }

      // PUBLIC ACTIVE WORKERS
      if (path === "/api/ustalar" && method === "GET") {
        const r = await env.DB.prepare("SELECT id,name,phone,specialty,status,photo_url,experience_years,bio FROM ustalar WHERE status = 'Faol' ORDER BY id DESC").all();
        return json({ success: true, ustalar: r.results || [] });
      }

      // ADMIN AUTH FOR ALL ADMIN ROUTES
      if (path.startsWith("/api/admin/") && !adminOK()) return json({ success: false, error: "Ruxsat yo'q. Admin parolini tekshiring." }, 401);

      // DASHBOARD STATS
      if (path === "/api/admin/stats" && method === "GET") {
        const orders = await env.DB.prepare(`SELECT COUNT(*) total,
          SUM(CASE WHEN status='Yangi' THEN 1 ELSE 0 END) new_orders,
          SUM(CASE WHEN status IN ('Qabul qilindi','Ustaga biriktirildi','Bajarilmoqda') THEN 1 ELSE 0 END) in_progress,
          SUM(CASE WHEN status='Tugallandi' THEN 1 ELSE 0 END) completed,
          SUM(CASE WHEN date(created_at)=date('now') THEN 1 ELSE 0 END) today_orders,
          SUM(CASE WHEN strftime('%Y-%m',created_at)=strftime('%Y-%m','now') THEN 1 ELSE 0 END) month_orders
          FROM orders`).first();
        const fin = await env.DB.prepare(`SELECT COALESCE(SUM(commission_amount),0) revenue,
          COALESCE(SUM(CASE WHEN payment_status='To''landi' THEN commission_amount ELSE 0 END),0) paid,
          COALESCE(SUM(CASE WHEN payment_status='Kutilmoqda' THEN commission_amount ELSE 0 END),0) pending
          FROM order_finances`).first();
        const exp = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) total FROM expenses").first();
        const revenue = num(fin?.revenue), expenses = num(exp?.total);
        return json({ success: true, stats: {
          total: num(orders?.total), new_orders: num(orders?.new_orders), in_progress: num(orders?.in_progress), completed: num(orders?.completed),
          today_orders: num(orders?.today_orders), month_orders: num(orders?.month_orders),
          commission_revenue: revenue, commission_paid: num(fin?.paid), commission_pending: num(fin?.pending), expenses,
          profit: revenue - expenses
        }});
      }

      // ORDERS: LIST + MANUAL CREATE
      if (path === "/api/admin/orders" && method === "GET") {
        const r = await env.DB.prepare(`SELECT o.*, f.order_price AS finance_price, f.commission_rate, f.commission_amount,
          f.payment_status AS commission_payment_status, f.payment_method, f.paid_at
          FROM orders o LEFT JOIN order_finances f ON f.order_id=o.id ORDER BY o.id DESC`).all();
        return json({ success: true, orders: r.results || [] });
      }
      if (path === "/api/admin/orders" && method === "POST") {
        const d = await body();
        const name = str(d?.name,150), rawPhone = str(d?.phone,40), service = str(d?.service,150), address = str(d?.address,300);
        const details = str(d?.details,2000), source = str(d?.source || "Boshqa",40);
        if (!name || !rawPhone || !service || !address) return json({ success:false,error:"Ism, telefon, xizmat va manzil majburiy" },400);
        const allowedSources = ["Instagram","Telegram","Telefon","Veb-sayt","Boshqa"];
        if (!allowedSources.includes(source)) return json({success:false,error:"Buyurtma manbasi noto'g'ri"},400);
        const r = await env.DB.prepare(`INSERT INTO orders (name,phone,service,address,details,status,created_at,source)
          VALUES (?,?,?,?,?,'Yangi',datetime('now'),?)`).bind(name,rawPhone,service,address,details,source).run();
        await ensureCustomer(name,rawPhone,address);
        await notifyAdmin(`🆕 USTA24 — ADMIN YANGI BUYURTMA\n#${r.meta?.last_row_id}\n${name}\n${rawPhone}\n${service}\nManba: ${source}`);
        return json({success:true,id:r.meta?.last_row_id,message:"Buyurtma qo'shildi"});
      }

      // ORDER UPDATE / DELETE
      let m = path.match(/^\/api\/admin\/orders\/(\d+)$/);
      if (m && ["PATCH","DELETE"].includes(method)) {
        const id = Number(m[1]);
        const order = await getOrder(id);
        if (!order) return json({success:false,error:"Buyurtma topilmadi"},404);
        if (method === "DELETE") {
          const f = await env.DB.prepare("SELECT id FROM order_finances WHERE order_id=?").bind(id).first();
          if (f) return json({success:false,error:"Moliyaviy yozuvi mavjud buyurtmani o'chirib bo'lmaydi. Bekor qilingan holatiga o'tkazing."},409);
          await env.DB.prepare("DELETE FROM orders WHERE id=?").bind(id).run();
          return json({success:true,message:"Buyurtma o'chirildi"});
        }
        const d = await body();
        if (!d) return json({success:false,error:"Ma'lumot noto'g'ri"},400);
        // Assign a worker
        if (d.worker_name !== undefined || d.worker_phone !== undefined) {
          const wn = str(d.worker_name,150), wp = str(d.worker_phone,40);
          const w = await env.DB.prepare("SELECT id,name,phone,telegram_chat_id FROM ustalar WHERE name=? AND phone=? AND status='Faol' LIMIT 1").bind(wn,wp).first();
          if (!w) return json({success:false,error:"Faol usta topilmadi"},404);
          await env.DB.prepare("UPDATE orders SET worker_name=?,worker_phone=?,status='Ustaga biriktirildi' WHERE id=?").bind(w.name,w.phone,id).run();
          await notifyCustomer(order.phone,`👨‍🔧 USTA 24 — SIZGA USTA BIRIKTIRILDI\nBuyurtma #${id}\nXizmat: ${order.service}\nUsta: ${w.name}\nTelefon: ${w.phone}`);
          if (w.telegram_chat_id) await workerTG(w.telegram_chat_id,`🔔 YANGI BUYURTMA #${id}\nMijoz: ${order.name}\nTelefon: ${order.phone}\nXizmat: ${order.service}\nManzil: ${order.address}\nIzoh: ${order.details || "Yo'q"}\n\nHolatni tugma orqali yangilang.`,{reply_markup:{inline_keyboard:[[{text:"✅ Buyurtmani qabul qilish",callback_data:`w:accept:${id}`}]]}});
          await notifyAdmin(`👷 Buyurtma #${id} ${w.name} ustaga biriktirildi.`);
          return json({success:true,message:"Usta biriktirildi",worker_name:w.name,worker_phone:w.phone,status:"Ustaga biriktirildi"});
        }
        const updates = [];
        if (d.name !== undefined) updates.push(["name",str(d.name,150)]);
        if (d.phone !== undefined) updates.push(["phone",str(d.phone,40)]);
        if (d.service !== undefined) updates.push(["service",str(d.service,150)]);
        if (d.address !== undefined) updates.push(["address",str(d.address,300)]);
        if (d.details !== undefined) updates.push(["details",str(d.details,2000)]);
        if (d.source !== undefined) {
          const src = str(d.source,40);
          if (!["Instagram","Telegram","Telefon","Veb-sayt","Boshqa","Noma'lum"].includes(src)) return json({success:false,error:"Manba noto'g'ri"},400);
          updates.push(["source",src]);
        }
        if (d.price !== undefined) {
          const price = num(d.price,-1);
          if (price < 0) return json({success:false,error:"Narx 0 dan kichik bo'lmasligi kerak"},400);
          const finance = await env.DB.prepare("SELECT * FROM order_finances WHERE order_id=?").bind(id).first();
          if (finance?.payment_status === "To'landi" && price !== num(finance.order_price)) return json({success:false,error:"Komissiya to'langan. Narxni o'zgartirish uchun avval moliyaviy yozuvni tekshiring."},409);
          updates.push(["price",price]);
        }
        if (d.status !== undefined) {
          const allowed = ["Yangi","Qabul qilindi","Ustaga biriktirildi","Bajarilmoqda","Tugallandi","Bekor qilindi"];
          if (!allowed.includes(d.status)) return json({success:false,error:"Buyurtma holati noto'g'ri"},400);
          if (d.status === "Tugallandi") {
            // Komissiya faqat yangi yakunlanayotgan buyurtmaga hisoblanadi.
            // Avvaldan Tugallandi bo'lgan eski buyurtmalarga keyin narx kiritilishi
            // avtomatik komissiya yaratmasligi kerak.
            for (const [k,v] of updates) {
              await env.DB.prepare(`UPDATE orders SET ${k}=? WHERE id=?`).bind(v,id).run();
            }
            if (order.status === "Tugallandi") {
              return json({success:true,message:"Buyurtma avvaldan tugallangan. Eski buyurtmaga komissiya avtomatik hisoblanmadi.",order:await getOrder(id)});
            }
            const done = await completeOrder(id);
            if (!done.ok) return json({success:false,error:done.error},400);
            await notifyCustomer(order.phone,`✅ USTA 24 — BUYURTMANGIZ TUGALLANDI\nBuyurtma #${id}\nXizmat: ${order.service}`);
            return json({success:true,message:"Buyurtma tugallandi, komissiya hisoblandi",commission:done.commission});
          }
          updates.push(["status",d.status]);
        }
        for (const [k,v] of updates) await env.DB.prepare(`UPDATE orders SET ${k}=? WHERE id=?`).bind(v,id).run();
        const fresh = await getOrder(id);
        if (d.name !== undefined || d.phone !== undefined || d.address !== undefined) await ensureCustomer(fresh.name,fresh.phone,fresh.address);
        if (d.price !== undefined) {
          const f = await env.DB.prepare("SELECT * FROM order_finances WHERE order_id=?").bind(id).first();
          if (f && f.payment_status !== "To'landi") {
            const commission = Math.round(num(d.price) * 0.10);
            await env.DB.prepare("UPDATE order_finances SET order_price=?,commission_amount=?,commission_rate=10 WHERE order_id=?").bind(num(d.price),commission,id).run();
          }
          if (fresh.status === "Tugallandi" && order.status !== "Tugallandi" && !f && num(d.price) > 0) await completeOrder(id);
        }
        if (d.status !== undefined) await notifyCustomer(fresh.phone,`📢 USTA 24 — BUYURTMANGIZ HOLATI\nBuyurtma #${id}\nHolat: ${fresh.status}`);
        return json({success:true,message:"Buyurtma yangilandi",order:await getOrder(id)});
      }

      // WORKERS
      if (path === "/api/admin/ustalar" && method === "GET") {
        const r = await env.DB.prepare("SELECT id,name,phone,specialty,status,created_at,telegram_chat_id,photo_url,experience_years,bio FROM ustalar ORDER BY id DESC").all();
        return json({success:true,ustalar:r.results||[]});
      }
      if (path === "/api/admin/ustalar" && method === "POST") {
        const d=await body(), name=str(d?.name,150), p=str(d?.phone,40), specialty=str(d?.specialty,150), status=str(d?.status||"Faol"), photo=str(d?.photo_url,1000), exp=Math.max(0,Math.min(80,num(d?.experience_years))), bio=str(d?.bio,1500);
        if(!name||!p) return json({success:false,error:"Usta ismi va telefoni kerak"},400);
        if(!["Faol","Nofaol"].includes(status)) return json({success:false,error:"Holat noto'g'ri"},400);
        const r=await env.DB.prepare("INSERT INTO ustalar(name,phone,specialty,status,photo_url,experience_years,bio) VALUES(?,?,?,?,?,?,?)").bind(name,p,specialty,status,photo,exp,bio).run();
        return json({success:true,id:r.meta?.last_row_id});
      }
      m=path.match(/^\/api\/admin\/ustalar\/(\d+)$/);
      if(m && ["PATCH","DELETE"].includes(method)){
        const id=Number(m[1]), w=await env.DB.prepare("SELECT id FROM ustalar WHERE id=?").bind(id).first();
        if(!w) return json({success:false,error:"Usta topilmadi"},404);
        if(method==="DELETE"){
          await env.DB.prepare("UPDATE ustalar SET status='Nofaol' WHERE id=?").bind(id).run();
          return json({success:true,message:"Usta nofaol qilindi; tarixiy buyurtmalar saqlandi"});
        }
        const d=await body(), name=str(d?.name,150), p=str(d?.phone,40), specialty=str(d?.specialty,150), status=str(d?.status||"Faol"), photo=str(d?.photo_url,1000), exp=Math.max(0,Math.min(80,num(d?.experience_years))), bio=str(d?.bio,1500);
        if(!name||!p||!["Faol","Nofaol"].includes(status)) return json({success:false,error:"Ism, telefon yoki holat noto'g'ri"},400);
        await env.DB.prepare("UPDATE ustalar SET name=?,phone=?,specialty=?,status=?,photo_url=?,experience_years=?,bio=? WHERE id=?").bind(name,p,specialty,status,photo,exp,bio,id).run();
        return json({success:true,message:"Usta yangilandi"});
      }

      // CUSTOMERS AND HISTORY
      if (path === "/api/admin/customers" && method === "GET") {
        const r=await env.DB.prepare(`SELECT c.id,c.name,c.phone,c.address,c.notes,c.created_at,
          COUNT(o.id) order_count, COALESCE(SUM(CASE WHEN o.status='Tugallandi' THEN 1 ELSE 0 END),0) completed_count,
          MAX(o.created_at) last_order_at
          FROM customers c LEFT JOIN orders o ON replace(replace(replace(o.phone,'+',''),' ',''),'-','') LIKE '%' || c.phone
          GROUP BY c.id ORDER BY last_order_at DESC`).all();
        return json({success:true,customers:r.results||[]});
      }
      m=path.match(/^\/api\/admin\/customers\/([^/]+)\/orders$/);
      if(m && method==="GET"){
        const p=decodeURIComponent(m[1]);
        const r=await env.DB.prepare("SELECT * FROM orders WHERE phone=? OR replace(replace(replace(phone,'+',''),' ',''),'-','')=? ORDER BY id DESC").bind(p,phone(p)).all();
        return json({success:true,orders:r.results||[]});
      }

      // SERVICES CRUD
      if(path==="/api/admin/services" && method==="GET") { const r=await env.DB.prepare("SELECT * FROM services ORDER BY id DESC").all(); return json({success:true,services:r.results||[]}); }
      if(path==="/api/admin/services" && method==="POST") {
        const d=await body(), name=str(d?.name,150), description=str(d?.description,1000), status=str(d?.status||"Faol");
        if(!name) return json({success:false,error:"Xizmat nomi kerak"},400);
        if(!["Faol","Nofaol"].includes(status)) return json({success:false,error:"Holat noto'g'ri"},400);
        try { const r=await env.DB.prepare("INSERT INTO services(name,description,status) VALUES(?,?,?)").bind(name,description,status).run(); return json({success:true,id:r.meta?.last_row_id}); }
        catch { return json({success:false,error:"Bu xizmat avvaldan mavjud"},409); }
      }
      m=path.match(/^\/api\/admin\/services\/(\d+)$/);
      if(m && ["PATCH","DELETE"].includes(method)){
        const id=Number(m[1]);
        if(method==="DELETE"){await env.DB.prepare("UPDATE services SET status='Nofaol' WHERE id=?").bind(id).run();return json({success:true});}
        const d=await body(), name=str(d?.name,150), description=str(d?.description,1000), status=str(d?.status||"Faol");
        if(!name||!["Faol","Nofaol"].includes(status)) return json({success:false,error:"Ma'lumot noto'g'ri"},400);
        await env.DB.prepare("UPDATE services SET name=?,description=?,status=? WHERE id=?").bind(name,description,status,id).run(); return json({success:true});
      }

      // FINANCE SUMMARY, COMMISSIONS, CASH COLLECTION
      if(path==="/api/admin/finance" && method==="GET"){
        const summary=await env.DB.prepare(`SELECT COALESCE(SUM(commission_amount),0) revenue,
          COALESCE(SUM(CASE WHEN payment_status='To''landi' THEN commission_amount ELSE 0 END),0) paid,
          COALESCE(SUM(CASE WHEN payment_status='Kutilmoqda' THEN commission_amount ELSE 0 END),0) pending FROM order_finances`).first();
        const expenses=await env.DB.prepare("SELECT COALESCE(SUM(amount),0) total FROM expenses").first();
        const rows=await env.DB.prepare(`SELECT f.*,o.name customer_name,o.phone,o.service,o.worker_name,o.status order_status,o.created_at
          FROM order_finances f JOIN orders o ON o.id=f.order_id ORDER BY f.id DESC`).all();
        return json({success:true,summary:{revenue:num(summary?.revenue),paid:num(summary?.paid),pending:num(summary?.pending),expenses:num(expenses?.total),profit:num(summary?.revenue)-num(expenses?.total)},commissions:rows.results||[]});
      }
      m=path.match(/^\/api\/admin\/finance\/commissions\/(\d+)$/);
      if(m && method==="PATCH"){
        const id=Number(m[1]), d=await body(), status=str(d?.payment_status);
        if(!["Kutilmoqda","To'landi"].includes(status)) return json({success:false,error:"To'lov holati noto'g'ri"},400);
        const f=await env.DB.prepare("SELECT * FROM order_finances WHERE order_id=?").bind(id).first();
        if(!f) return json({success:false,error:"Komissiya topilmadi"},404);
        await env.DB.prepare("UPDATE order_finances SET payment_status=?,payment_method='Naqd',paid_at=? WHERE order_id=?").bind(status,status==="To'landi"?new Date().toISOString():null,id).run();
        return json({success:true,message:"To'lov holati yangilandi"});
      }
      if(path==="/api/admin/expenses" && method==="GET"){const r=await env.DB.prepare("SELECT * FROM expenses ORDER BY expense_date DESC,id DESC").all();return json({success:true,expenses:r.results||[]});}
      if(path==="/api/admin/expenses" && method==="POST"){
        const d=await body(), title=str(d?.title,200), category=str(d?.category,100), amount=num(d?.amount,-1), date=str(d?.expense_date||new Date().toISOString().slice(0,10),20), notes=str(d?.notes,1000);
        if(!title||amount<0) return json({success:false,error:"Xarajat nomi va to'g'ri summa kerak"},400);
        const r=await env.DB.prepare("INSERT INTO expenses(title,category,amount,expense_date,notes) VALUES(?,?,?,?,?)").bind(title,category,amount,date,notes).run();return json({success:true,id:r.meta?.last_row_id});
      }
      m=path.match(/^\/api\/admin\/expenses\/(\d+)$/);
      if(m && method==="DELETE"){await env.DB.prepare("DELETE FROM expenses WHERE id=?").bind(Number(m[1])).run();return json({success:true});}

      // REVIEWS
      if(path==="/api/admin/reviews" && method==="GET"){const r=await env.DB.prepare("SELECT * FROM reviews ORDER BY id DESC").all();return json({success:true,reviews:r.results||[]});}
      if(path==="/api/admin/reviews" && method==="POST"){
        const d=await body(), name=str(d?.customer_name,150), p=str(d?.phone,40), rating=num(d?.rating,0), comment=str(d?.comment,2000), status=str(d?.status||"Kutilmoqda");
        if(!name||rating<1||rating>5) return json({success:false,error:"Mijoz ismi va 1–5 baho kerak"},400);
        const r=await env.DB.prepare("INSERT INTO reviews(customer_name,phone,rating,comment,status) VALUES(?,?,?,?,?)").bind(name,p,rating,comment,status).run();return json({success:true,id:r.meta?.last_row_id});
      }
      m=path.match(/^\/api\/admin\/reviews\/(\d+)$/);
      if(m && ["PATCH","DELETE"].includes(method)){
        const id=Number(m[1]); if(method==="DELETE"){await env.DB.prepare("DELETE FROM reviews WHERE id=?").bind(id).run();return json({success:true});}
        const d=await body(), status=str(d?.status); if(!["Kutilmoqda","Tasdiqlandi","Rad etildi"].includes(status))return json({success:false,error:"Sharh holati noto'g'ri"},400);
        await env.DB.prepare("UPDATE reviews SET status=? WHERE id=?").bind(status,id).run();return json({success:true});
      }

      // AD CAMPAIGNS
      if(path==="/api/admin/ads" && method==="GET"){const r=await env.DB.prepare("SELECT * FROM ad_campaigns ORDER BY campaign_date DESC,id DESC").all();return json({success:true,campaigns:r.results||[]});}
      if(path==="/api/admin/ads" && method==="POST"){
        const d=await body(), platform=str(d?.platform,50), name=str(d?.campaign_name,200), spend=num(d?.spend,-1), impressions=num(d?.impressions), clicks=num(d?.clicks), leads=num(d?.leads), date=str(d?.campaign_date||new Date().toISOString().slice(0,10),20), notes=str(d?.notes,1000);
        if(!platform||!name||spend<0) return json({success:false,error:"Platforma, kampaniya nomi va xarajat kerak"},400);
        const r=await env.DB.prepare("INSERT INTO ad_campaigns(platform,campaign_name,spend,impressions,clicks,leads,campaign_date,notes) VALUES(?,?,?,?,?,?,?,?)").bind(platform,name,spend,impressions,clicks,leads,date,notes).run();return json({success:true,id:r.meta?.last_row_id});
      }
      m=path.match(/^\/api\/admin\/ads\/(\d+)$/);
      if(m && method==="DELETE"){await env.DB.prepare("DELETE FROM ad_campaigns WHERE id=?").bind(Number(m[1])).run();return json({success:true});}

      // ADMIN WORK GALLERY
      if(path==="/api/admin/gallery" && method==="GET"){const r=await env.DB.prepare("SELECT * FROM work_gallery ORDER BY id DESC").all();return json({success:true,items:r.results||[]});}
      if(path==="/api/admin/gallery" && method==="POST"){
        const d=await body(), title=str(d?.title,200), imageUrl=str(d?.image_url,1000), description=str(d?.description,1000), category=str(d?.category,100);
        if(!title||!/^https:\/\//i.test(imageUrl)) return json({success:false,error:"Nomi va https:// bilan boshlanuvchi rasm havolasi kerak"},400);
        const r=await env.DB.prepare("INSERT INTO work_gallery(title,description,image_url,category) VALUES(?,?,?,?)").bind(title,description,imageUrl,category).run();return json({success:true,id:r.meta?.last_row_id});
      }
      m=path.match(/^\/api\/admin\/gallery\/(\d+)$/);
      if(m && method==="DELETE"){await env.DB.prepare("DELETE FROM work_gallery WHERE id=?").bind(Number(m[1])).run();return json({success:true});}

      // ADMIN SITE CONTENT
      if(path==="/api/admin/site-content" && method==="GET"){const r=await env.DB.prepare("SELECT * FROM site_content ORDER BY content_key").all();return json({success:true,content:r.results||[]});}
      if(path==="/api/admin/site-content" && method==="PATCH"){
        const d=await body(), allowed={about_title:150,about_text:3000,hero_title:180,hero_text:500};
        for(const [key,value] of Object.entries(d||{})){if(!(key in allowed))return json({success:false,error:"Noma'lum kontent kaliti"},400);await env.DB.prepare("INSERT INTO site_content(content_key,content_value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(content_key) DO UPDATE SET content_value=excluded.content_value,updated_at=datetime('now')").bind(key,str(value,allowed[key])).run();}
        return json({success:true});
      }

      // SAFE PUBLIC SETTINGS (NO TOKENS / PASSWORDS)
      if(path==="/api/admin/settings" && method==="GET"){
        const r=await env.DB.prepare("SELECT setting_key,setting_value,updated_at FROM app_settings ORDER BY setting_key").all();return json({success:true,settings:r.results||[]});
      }
      if(path==="/api/admin/settings" && method==="PATCH"){
        const d=await body(); const allowed={public_phone:100,telegram_channel:300,customer_bot_url:300,website_url:300};
        const entries=Object.entries(d||{});
        if(!entries.length) return json({success:false,error:"Sozlama yuborilmadi"},400);
        for(const [key,value] of entries){if(!(key in allowed))return json({success:false,error:"Bu sozlamani o'zgartirishga ruxsat yo'q: "+key},400);await env.DB.prepare(`INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=datetime('now')`).bind(key,str(value,allowed[key])).run();}
        return json({success:true,message:"Sozlamalar saqlandi"});
      }

      // API yo'llari topilmasa, HTML fayllariga o'tkazib yubormaymiz.
      if (path.startsWith("/api/")) {
        return json({ success: false, error: "API manzili topilmadi" }, 404);
      }

      // SAYT VA ADMIN HTML FAYLLARI
      if (!env.ASSETS) {
        return new Response("ASSETS binding sozlanmagan. Cloudflare'da ASSETS bindingni tekshiring.", {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      if (method === "GET" && (path === "/admin" || path === "/admin/" || path === "/admin.html")) {
        const assetUrl = new URL(request.url);
        assetUrl.pathname = "/admin.html";
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }

      if (method === "GET" && path === "/") {
        const assetUrl = new URL(request.url);
        assetUrl.pathname = "/index.html";
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("SERVER XATOSI:",error);
      return json({success:false,error:"Serverda xatolik yuz berdi"},500);
    }
  }
};
