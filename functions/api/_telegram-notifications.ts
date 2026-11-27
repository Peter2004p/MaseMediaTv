type NotificationEpisode = {
  season?: number | string;
  episode?: number | string;
  title?: string;
};

type NotificationTitle = {
  id?: string;
  name?: string;
  type?: string;
  year?: string | number;
  description?: string;
  posterUrl?: string;
};

type TelegramNotificationEnv = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_MINI_APP_URL?: string;
  TELEGRAM_WEBAPP_URL?: string;
};

/**
 * Sends one announcement to every active private bot subscriber and every
 * explicitly registered channel/group. A paused subscriber (active=0) is
 * intentionally excluded.
 */
export async function sendTelegramTitleNotifications(
  env: TelegramNotificationEnv,
  title: NotificationTitle,
  isNewTitle: boolean,
  newEpisodes: NotificationEpisode[]
): Promise<{ attempted: boolean; delivered: number; failed: number }> {
  const stats = { attempted: false, delivered: 0, failed: 0 };
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token || (!isNewTitle && newEpisodes.length === 0)) return stats;

  if (!isNewTitle && newEpisodes.length) {
    const metadata = (title as NotificationTitle & { telegramEpisodeChannelLink?: string; telegramEpisodeChannelChatId?: string }) ;
    const rawChannel = String(metadata.telegramEpisodeChannelChatId || metadata.telegramEpisodeChannelLink || "").trim();
    if (!rawChannel) {
      console.info("Episode announcement skipped: no individual Telegram channel link is configured for", title.id || title.name);
      return stats;
    }
    const channelInput = rawChannel.startsWith("-100") ? rawChannel : rawChannel.replace(/^https?:\/\/(?:www\.)?t\.me\//i, "").replace(/^@/, "").replace(/\/$/, "");
    if (!channelInput || /[/?#]/.test(channelInput)) {
      console.warn("Episode announcement skipped: the saved individual channel link is not a public t.me channel link.");
      return stats;
    }
    const botToken = token;
    const api = async (method: string, payload: Record<string, unknown>) => {
      const response = await fetch("https://api.telegram.org/bot" + botToken + "/" + method, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: { message_id?: number; chat?: { id?: number; username?: string }; id?: number; username?: string }; description?: string };
      if (!response.ok || !data.ok) throw new Error(data.description || "Telegram " + method + " failed");
      return data.result || {};
    };
    const individualChat = await api("getChat", { chat_id: channelInput.startsWith("-100") ? channelInput : "@" + channelInput });
    const individualChatId = String(individualChat.id || "");
    if (!individualChatId) throw new Error("Telegram did not return the individual channel ID.");
    const poster = String(title.posterUrl || "").trim();
    const titleName = String(title.name || "Untitled").trim().slice(0, 180);
    const miniAppUrl = "https://t.me/MaseTv_Bot?startapp=" + encodeURIComponent("title_" + String(title.id || ""));
    const mainChannel = "@MaseMediaTv";
    const ensureLog = await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_episode_notification_log (
      title_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (title_id, season, episode)
    )`).run();
    void ensureLog;
    stats.attempted = true;
    for (const ep of newEpisodes) {
      const season = Math.max(1, Number(ep.season) || 1);
      const episode = Math.max(1, Number(ep.episode) || 1);
      const titleLine = "🎬 " + titleName + "\n" + (season > 1 ? "Season " + season + " · " : "") + "Episode " + episode +
        (ep.title && !/^episode\s+\d+$/i.test(String(ep.title)) ? " — " + String(ep.title).slice(0, 100) : "");
      const claimed = await env.DB.prepare("INSERT OR IGNORE INTO telegram_episode_notification_log (title_id,season,episode) VALUES (?,?,?)")
        .bind(String(title.id || title.name || "unknown"), season, episode).run();
      if (!Number(claimed.meta?.changes || 0)) continue;
      try {
        const individualText = "🍿 NEW EPISODE OUT!\n\n" + titleLine + "\n\n▶️ Watch in MaseNet: " + miniAppUrl;
        let individualMessage: { message_id?: number; chat?: { username?: string } } = {};
        if (/^https:\/\//i.test(poster)) {
          try {
            individualMessage = await api("sendPhoto", {
              chat_id: individualChatId, photo: poster, caption: individualText.slice(0, 1024),
              reply_markup: { inline_keyboard: [[{ text: "▶️ Watch in MaseNet", url: miniAppUrl }]] }
            });
          } catch {
            individualMessage = await api("sendMessage", {
              chat_id: individualChatId, text: individualText,
              reply_markup: { inline_keyboard: [[{ text: "▶️ Watch in MaseNet", url: miniAppUrl }]] }
            });
          }
        } else {
          individualMessage = await api("sendMessage", {
            chat_id: individualChatId, text: individualText,
            reply_markup: { inline_keyboard: [[{ text: "▶️ Watch in MaseNet", url: miniAppUrl }]] }
          });
        }
        const channelUsername = String(individualChat.username || channelInput.replace(/^@/, ""));
        const messageId = Number(individualMessage.message_id || 0);
        const channelPostUrl = channelUsername && messageId
          ? "https://t.me/" + channelUsername + "/" + messageId
          : individualChatId.startsWith("-100") && messageId
            ? "https://t.me/c/" + individualChatId.slice(4) + "/" + messageId
            : "https://t.me/" + channelUsername;
        const mainText = "🔔 NEW EPISODE OUT!\n\n" + titleLine + "\n\nThe latest episode is now available in its dedicated channel.";
        try {
          await api("sendMessage", {
            chat_id: mainChannel, text: mainText,
            reply_markup: { inline_keyboard: [[{ text: "📺 Go to " + titleName.slice(0, 45) + " Episode", url: channelPostUrl }]] }
          });
        } catch (mainError) {
          console.error("Main MaseMediaTv episode announcement failed:", mainError instanceof Error ? mainError.message : String(mainError));
        }
        stats.delivered++;
      } catch (error) {
        await env.DB.prepare("DELETE FROM telegram_episode_notification_log WHERE title_id=? AND season=? AND episode=?")
          .bind(String(title.id || title.name || "unknown"), season, episode).run().catch(() => undefined);
        stats.failed++;
        console.error("Individual episode announcement failed:", error instanceof Error ? error.message : String(error));
      }
    }
    return stats;
  }

  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_subscribers (
      chat_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL, title TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();

    const subscribers = await env.DB.prepare(
      "SELECT chat_id FROM telegram_subscribers WHERE active=1 AND chat_type IN ('private','channel','supergroup')"
    ).all<{ chat_id: string }>();
    const targets = [...new Set((subscribers.results || []).map(row => String(row.chat_id)).filter(Boolean))];
    const botUsername = "MaseTv_Bot";
    const appLink = "https://t.me/" + botUsername + "?startapp=" + encodeURIComponent("title_" + String(title.id || ""));
    const name = String(title.name || "Untitled").trim().slice(0, 180);
    const announcement = isNewTitle
      ? "🎬 NEW " + (String(title.type || "").toLowerCase() === "drama" ? "DRAMA" : "MOVIE") +
        " ON MASETV\n\n" + name +
        (title.year ? " (" + String(title.year).slice(0, 4) + ")" : "") +
        (title.description ? "\n\n" + String(title.description).trim().slice(0, 450) : "") +
        "\n\n▶️ Watch in MaseNet on Telegram: " + appLink
      : "🍿 NEW EPISODE\n\n" + name + "\n" +
        newEpisodes.map(ep =>
          "Season " + String(ep.season || 1) + " · Episode " + String(ep.episode || "?") +
          (ep.title ? " — " + String(ep.title).slice(0, 100) : "")
        ).join("\n") +
        "\n\n▶️ Open in MaseNet on Telegram: " + appLink;

    stats.attempted = true;
    for (const chatId of targets) {
      try {
        const poster = typeof title.posterUrl === "string" ? title.posterUrl.trim() : "";
        const canSendPoster = isNewTitle && /^https:\/\//i.test(poster);
        const method = canSendPoster ? "sendPhoto" : "sendMessage";
        const payload: Record<string, unknown> = canSendPoster
          ? { chat_id: chatId, photo: poster, caption: announcement.slice(0, 1024) }
          : { chat_id: chatId, text: announcement, disable_web_page_preview: true };
        const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
        if (response.ok && data.ok) {
          stats.delivered++;
          continue;
        }

        if (canSendPoster) {
          const fallback = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: announcement, disable_web_page_preview: true })
          }).catch(() => null);
          const fallbackData = (fallback
            ? await fallback.json().catch(() => ({}))
            : {}) as { ok?: boolean; description?: string };
          if (fallback?.ok && fallbackData.ok) {
            stats.delivered++;
            continue;
          }
        }

        stats.failed++;
        if (/blocked by the user|chat not found|bot was kicked|user is deactivated/i.test(String(data.description || ""))) {
          await env.DB.prepare(
            "UPDATE telegram_subscribers SET active=0,updated_at=datetime('now') WHERE chat_id=?"
          ).bind(chatId).run();
        }
        console.error("MaseNet Telegram announcement failed for chat", chatId, data.description || response.status);
      } catch (error) {
        stats.failed++;
        console.error("MaseNet Telegram announcement request failed:", error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    stats.failed++;
    console.error("MaseNet Telegram announcement dispatch failed:", error instanceof Error ? error.message : String(error));
  }

  return stats;
}
