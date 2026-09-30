// Active Coach · setelah login di Strava, arahkan kembali ke aplikasi Android lewat deep link.
// Daftarkan domain project Supabase (xxxx.supabase.co) sebagai "Authorization Callback Domain" di Strava.
Deno.serve((req) => {
  const q = new URL(req.url).searchParams.toString();
  return new Response(null, {
    status: 302,
    headers: { Location: 'activecoach://strava' + (q ? '?' + q : ''), 'Cache-Control': 'no-store' },
  });
});
