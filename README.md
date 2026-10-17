# Liman TV

Xtream hesabındaki canlı kanalları kendi web adresinde, kategorilere ayrılmış hâlde izlemen için küçük bir sunucu ve oynatıcı.

## Kurulum

```bash
npm install
cp .env.example .env      # sonra .env içine kendi Xtream bilgilerini yaz
npm start
```

Sunucu açılınca terminalde iki adres görürsün:

- `http://localhost:8080`: bu bilgisayardan
- `http://192.168.x.x:8080`: aynı Wi-Fi'daki telefon, tablet ya da TV'den

## Neler var

- Kategoriler, Tüm Kanallar, **Favoriler** ve **Son İzlediklerin**
- Kategori ve kanal araması (Türkçe karakterlere duyarsız: "gundem" yazınca "Gündem" bulunur)
- Oynatıcı: önce **MPEG-TS** (mpegts.js, düşük gecikme) dener, açılmazsa kendiliğinden **HLS**'e geçer. Safari ve iOS yerel HLS kullanır.
- Kısa yayın akışı (EPG): şu an ne oynuyor, ilerleme çubuğu ve sıradaki programlar
- Hesap durumu, bitiş tarihi ve bağlantı sayısı
- Şifreli giriş (`APP_PASSWORD`), 30 gün hatırlanır
- Klavye: `↑/↓` kanal değiştirir, `F` tam ekran, `M` sesi açar/kapatır, `/` arama kutusuna gider

## Nasıl çalışır

```
Tarayıcı ──► Liman TV sunucusu ──► Xtream sağlayıcı
            (şifre, önbellek,      (player_api.php,
             yayın proxy'si)        /live/...)
```

- Xtream kullanıcı adın ve şifren sadece sunucuda kalır, tarayıcıya hiç gitmez.
- Yayınlar ve logolar aynı adres üzerinden aktarılır. Böylece CORS ve HTTPS/HTTP karışıklığı yaşanmaz.
- Proxy linkleri AES-256-GCM ile şifrelenir; sağlayıcı adresi ve kimlik bilgileri gizlenir. Tokenler rota bazında doğrulanır ve sunucu başkalarına açık bir proxy olarak kullanılamaz.
- Kanal değiştirdiğinde ya da sekmeyi kapattığında sağlayıcıyla olan bağlantı hemen kapanır. Tek bağlantılı hesaplarda bu önemli.

## İnternetten erişim

| Yöntem | Not |
| --- | --- |
| **Cloudflare Tunnel** | `cloudflared tunnel --url http://localhost:8080`. Port açmadan HTTPS adres verir. |
| **VPS + Docker** | `docker build -t liman-tv . && docker run -d --env-file .env -p 8080:8080 liman-tv` |
| **Tailscale** | Sadece kendi cihazlarından erişmek için en güvenli yol. |

> İnternete açacaksan `APP_PASSWORD`'u mutlaka güçlü bir şifre yap.
> Yayın trafiği sunucunun üzerinden geçer, yani VPS bant genişliğini hesaba kat.

## Sık karşılaşılan durumlar

- **"Sağlayıcı yayını reddetti"**: Hesabının aynı anda izin verdiği bağlantı sayısı dolmuş olabilir. Başka bir cihazda açık kalan yayını kapat.
- **Görüntü var, ses yok / hiç açılmıyor**: Bazı kanallar HEVC (H.265) ya da AC-3 ses kullanır. Biçim seçiciden HLS'i dene ya da Safari/Edge ile aç.
- **Kanallar hiç gelmiyor**: Bazı sağlayıcılar bilinmeyen istemcileri reddeder. `.env` içinde `USER_AGENT` değerini değiştirip dene.
- **Liste eski görünüyor**: Kenar çubuğunun altındaki yenile düğmesi önbelleği temizler (varsayılan önbellek süresi 10 dakika).
# liman-tv

## Render ücretsiz yayın

- Kaynak depo: https://github.com/bugrasnmz/liman-tv
- Blueprint: `render.yaml`; Node.js 22, Free plan, Frankfurt.
- Sağlık kontrolü: `/healthz` (sağlayıcıdan bağımsız).
- `XTREAM_URL`, `XTREAM_USERNAME`, `XTREAM_PASSWORD`, `APP_PASSWORD` yalnızca Render ortam değişkenlerinde tutulur; `.env` GitHub’a yüklenmez.
- Üretimde giriş şifresi en az 12 karakter olmalıdır.
- 15 dakika istek almayan servis uyur; sonraki açılış yaklaşık bir dakika sürebilir.
- Video trafiği sunucudan geçtiği için ücretsiz kota sınırlıdır. Ödeme yöntemi varsa kota aşımı ücret doğurabilir; ücretsiz kullanım için faturalandırma ayarlarını kontrol et.
- Ücretsiz plan sınırları: https://render.com/docs/free

## Kanal listesi geliyor ama yayınlar açılmıyor

Sağlayıcı `FORCED_COUNTRY_INVALID` yanıtı veriyorsa hesap belirli bir ülkeye kilitlidir. Render Frankfurt sunucusunun Almanya çıkışı kullanması nedeniyle liste erişilebilirken video istekleri reddedilebilir. MPEG-TS/HLS değiştirmek bunu çözmez. Sağlayıcıdan sunucunun ülkesi için izin istemek veya sunucuyu hesabın izin verdiği ülkede barındırmak gerekir. Uygulama bu HTML hata sayfasını artık video olarak iletmez; erişim reddi döndürür.
