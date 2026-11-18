
      // =====================================
      // 7. BUYURTMA HOLATI VA USTANI BIRIKTIRISH
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

        const order = await env.DB.prepare(`
          SELECT id FROM orders WHERE id = ?
        `).bind(id).first();

        if (!order) {
          return jsonResponse({ error: "Buyurtma topilmadi" }, 404);
        }

        // USTANI BIRIKTIRISH
        if (data.worker_name !== undefined || data.worker_phone !== undefined) {
          if (
            !data.worker_name ||
            !data.worker_phone
          ) {
            return jsonResponse({
              error: "Usta ismi va telefoni kerak"
            }, 400);
          }

          const worker = await env.DB.prepare(`
            SELECT id FROM ustalar
            WHERE name = ? AND phone = ? AND status = 'Faol'
          `).bind(
            String(data.worker_name).trim(),
            String(data.worker_phone).trim()
          ).first();

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
          `).bind(
            String(data.worker_name).trim(),
            String(data.worker_phone).trim(),
            id
          ).run();

          return jsonResponse({
            success: true,
            message: "Usta buyurtmaga biriktirildi",
            orderId: id,
            worker_name: data.worker_name,
            worker_phone: data.worker_phone,
            status: "Ustaga biriktirildi"
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
