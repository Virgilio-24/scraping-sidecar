import { fetchProductDetails } from "./src/services/temu.js";
const url = "https://www.temu.com/pt/conjunto-de-camisola-e--de---de-cetim-para-mulheres-roupa-de-dormir-de-cor--com-decote-em-v-e--de--contrastante--para--as--elegante-roupa-de-casa-para--roupa-de-dormir-confort%C3%A1vel-roupa-de-dormir-elegante-acabamento-de-cetim-roupa-de-dormir-para-mulheres-camisola-para-mulheres-roupa-interior-para-mulheres-conjunto-de-pijama-de-cetim-para-mulheres-g-601099555477841.html?top_gallery_url=https%3A%2F%2Fimg.kwcdn.com%2Fproduct%2Ffancy%2Fcb53fe42-5c02-434a-93e9-b41568d24bde.jpg&spec_id=15067&spec_gallery_id=1005&refer_page_sn=10005&freesia_scene=1&_oak_freesia_scene=1&_oak_rec_ext_1=NTkz&_oak_gallery_order=998261637%2C1171169460%2C386719375%2C1057664200%2C529760259&_oak_mp_inf=ENGy6qum1ogBGiAwNzI3ZDk4MjU4ZWQ0MDFiOWNlY2I2M2M4ZGU4M2E1NSDTveCG5jM%3D&spec_ids=15067%2C16057%2C16084%2C2001%2C15092%2C2%2C3002%2C15082&refer_page_el_sn=200024&refer_page_name=home&refer_page_id=10005_1779741236387_i4l5t1dz7r&_x_sessn_id=odixyu4iy2";
try {
  const data = await fetchProductDetails(url);
  console.log(JSON.stringify({ ok: true, data }, null, 2));
} catch (error) {
  console.error('SCRAPER_ERROR_JSON');
  console.error(JSON.stringify({
    name: error?.name,
    message: error?.message,
    details: error?.details || null,
    stack: error?.stack || null,
  }, null, 2));
  process.exitCode = 1;
}
