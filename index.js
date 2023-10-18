import fetch from "node-fetch";
import cheerio from "cheerio";
import fs from "fs";

const loginUrl = "https://vrijopnaam.app/login/demo/";
const pricingUrl = "https://vrijopnaam.app/mc/65981/pricing-electricity/";

const dutchMonths = [
  "januari",
  "februari",
  "maart",
  "april",
  "mei",
  "juni",
  "juli",
  "augustus",
  "september",
  "oktober",
  "november",
  "december",
];

const defaultHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/118.0",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.7,nl;q=0.3",
  "Accept-Encoding": "gzip, deflate, br",
  Origin: "https://vrijopnaam.app",
  DNT: "1",
  Referer: loginUrl,
  Connection: "keep-alive",
};

async function login() {
  const response = await fetch(loginUrl, {
    headers: defaultHeaders,
    redirect: "manual",
  });
  const body = await response.text();
  const $ = cheerio.load(body);
  const csrfToken = $('input[name="csrfmiddlewaretoken"]').val();

  const headers = {
    ...defaultHeaders,
    Referer: loginUrl,
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: `csrftoken=${csrfToken}`,
  };

  const postData = `csrfmiddlewaretoken=${csrfToken}&code=regenachtig&show_dynamic_pricing=on&username=&password=`;

  // Wait 500ms before sending the login request
  await new Promise((resolve) => setTimeout(resolve, 500));

  const response2 = await fetch(loginUrl, {
    method: "POST",
    headers: headers,
    body: postData,
    redirect: "manual",
  });

  const cookies = response2.headers.raw()["set-cookie"];

  return cookies;
}

async function fetchPricing(cookies) {
  const headers = new Headers(defaultHeaders);

  headers.set("Referer", "https://vrijopnaam.app/mc/65981/");

  for (const cookie of cookies) {
    headers.append("cookie", cookie);
  }

  const response = await fetch(pricingUrl, {
    headers,
    redirect: "follow",
  });
  const body = await response.text();

  const $ = cheerio.load(body);

  const prices = [];

  // on the page, find the "19 oktober 2023" in this text:
  /* <h2 class="pricing-chart-title" data-title-day="tomorrow">
    <div class="pricing-chart-default">
        Morgen - do 19 oktober 2023
    </div> */

  const tomorrowElement = $(
    '.pricing-chart-title[data-title-day="tomorrow"] .pricing-chart-default'
  )
    .text()
    .split(" - ")[1]
    .trim()
    .split(" ")
    .slice(1)
    .join(" ");

  // convert 19 oktober 2023 to 2023-10-19
  const [day, month, year] = tomorrowElement.split(" ");
  const tomorrowDate = new Date(
    `${year}-${dutchMonths.indexOf(month) + 1}-${day}`
  );
  const todayDate = new Date(tomorrowDate.getTime() - 24 * 60 * 60 * 1000);

  const today = todayDate.toISOString().split("T")[0];
  const tomorrow = tomorrowDate.toISOString().split("T")[0];

  $(".pricing-table tbody tr").each(function () {
    const period = $(this).find(".column-period span").text();
    const todayPrice = $(this)
      .find("td.column-tariff:nth-child(2) span")
      .text();
    const tomorrowPrice = $(this)
      .find("td.column-tariff:nth-child(3)")
      .text()
      .trim();

    prices.push(
      {
        date: new Date(`${today}T${period.split(" - ")[0]}:00:00Z`),
        price: parseFloat(todayPrice.replace(",", ".")),
      },
      {
        date: new Date(`${tomorrow}T${period.split(" - ")[0]}:00:00Z`),
        price: parseFloat(tomorrowPrice.replace(",", ".")),
      }
    );
  });

  // Sort by date
  prices.sort((a, b) => a.date - b.date);

  return prices;
}

async function main() {
  const cookies = await login();
  const pricingData = await fetchPricing(cookies);
  const json = {
    source: "Vrij op naam",
    description:
      "All-in-prijs: dit is de kale inkoopprijs zoals deze op de stroombeurs geldt, plus de inkoopvergoeding, energiebelasting en ODE (1ste staffel), inclusief btw. Je kunt bij 'Mijn gegevens' de prijsweergave aanpassen.",
    updated_at: new Date(),
    prices: pricingData,
  };

  fs.writeFileSync("./prices.json", JSON.stringify(json, null, 2));
}

main();
