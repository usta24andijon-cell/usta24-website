
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/order" && request.method === "POST") {
      try {
        const data = await request.json();

        if (!data.name || !data.phone || !data.service || !data.address) {
          return Response.json(
            { error: "Majburiy ma'lumotlar kiritilmagan" },
            { status: 400 }
          );
        }

        const message =
          "🛠 USTA 24 — YANGI BUYURTMA\n\n" +
          "👤 Ism: " + data.name + "\n" +
          "📞 Telefon: " + data.phone + "\n" +
          "🔧 Xizmat: " + data.service + "\n" +
          "📍 Manzil: " + data.address + "\n" +
          "📝 Izoh: " + (data.details || "Yo'q");

        const telegram = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: message
            })
          }
        );

        if (!telegram.ok) {
          return Response.json(
            { error: "Telegramga yuborishda xatolik" },
            { status: 502 }
          );
        }

        return Response.json({ success: true });
      } catch (error) {
        return Response.json(
          { error: "Server xatosi" },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
