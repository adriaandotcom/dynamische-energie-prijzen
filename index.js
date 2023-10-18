import cheerio from "cheerio";
import fs from "fs";
import core from "@actions/core";

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
  });
  const body = await response.text();
  const $ = cheerio.load(body);
  const csrfToken = $('input[name="csrfmiddlewaretoken"]').val();

  const password = $(".section-form.demo-user-page .centered b")
    .first()
    .text()
    .trim();

  const headers = {
    ...defaultHeaders,
    Referer: loginUrl,
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: `csrftoken=${csrfToken}`,
  };

  const postData = `csrfmiddlewaretoken=${csrfToken}&code=${password}&show_dynamic_pricing=on&username=&password=`;

  // Wait 500ms before sending the login request
  await new Promise((resolve) => setTimeout(resolve, 500));

  const response2 = await fetch(loginUrl, {
    method: "POST",
    headers: headers,
    body: postData,
    redirect: "manual",
  });

  const cookies = response2.headers.getSetCookie();

  return cookies;
}

async function fetchPricing(cookies) {
  const parsedCookies = cookies
    .map((entry) => {
      const parts = entry.split(";");
      const cookiePart = parts[0];
      return cookiePart;
    })
    .join(";");

  const response = await fetch(pricingUrl, {
    headers: {
      ...defaultHeaders,
      cookie: parsedCookies,
    },
    redirect: "follow",
  });
  const body = await response.text();

  const $ = cheerio.load(body);

  if ($(".pricing-table tbody tr").length === 0)
    throw new Error("No pricing data found");

  const hasTomorrow = $(
    '.pricing-chart-title[data-title-day="tomorrow"]'
  ).length;
  const hasYesterday = $(
    '.pricing-chart-title[data-title-day="yesterday"]'
  ).length;

  if (!hasTomorrow && !hasYesterday) throw new Error("No date found");

  const prices = [];

  // on the page, find the "19 oktober 2023" in this text:
  /* <h2 class="pricing-chart-title" data-title-day="tomorrow">
    <div class="pricing-chart-default">
        Morgen - do 19 oktober 2023
    </div> */

  const daySlug = hasTomorrow ? "tomorrow" : "yesterday";

  const dayElement = $(
    `.pricing-chart-title[data-title-day="${daySlug}"] .pricing-chart-default`
  )
    .text()
    .trim()
    .split(" - ")[1]
    .trim()
    .split(" ")
    .slice(1)
    .join(" ");

  // convert 19 oktober 2023 to 2023-10-19
  const [day, month, year] = dayElement.split(" ");
  const currentDate = new Date(
    `${year}-${dutchMonths.indexOf(month) + 1}-${day}`
  );
  const tomorrowDate = hasTomorrow
    ? new Date(currentDate.getTime())
    : new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);

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

    const todayHour = parseInt(period.split(" - ")[0]);
    const todayRowDate = new Date(`${today}T${period.split(" - ")[0]}:00:00Z`);
    const tomorrowHour = parseInt(period.split(" - ")[1]);
    const tomorrowRowDate = new Date(
      `${tomorrow}T${period.split(" - ")[1]}:00:00Z`
    );

    prices.push(
      {
        iso: todayRowDate,
        date: todayRowDate.toISOString().split("T")[0],
        hour: todayHour,
        price: parseFloat(todayPrice.replace(",", ".")),
      },
      {
        iso: tomorrowRowDate,
        date: tomorrowRowDate.toISOString().split("T")[0],
        hour: tomorrowHour,
        price: parseFloat(tomorrowPrice.replace(",", ".")),
      }
    );
  });

  // Sort by date
  prices.sort((a, b) => a.iso - b.iso);

  return prices;
}

try {
  const cookies = await login();
  const pricingData = await fetchPricing(cookies);

  // get last price from prices.json
  const lastPriceJson = JSON.parse(
    fs.readFileSync("./prices.json")
  ).prices.slice(-1)[0];
  const lastPriceNew = pricingData.slice(-1)[0];

  const didChange =
    new Date(lastPriceJson.iso).getTime() !==
    new Date(lastPriceNew.iso).getTime();

  const updated_at = new Date();
  const json = {
    source: "Vrij op naam",
    description:
      "All-in-prijs: dit is de kale inkoopprijs zoals deze op de stroombeurs geldt, plus de inkoopvergoeding, energiebelasting en ODE (1ste staffel), inclusief btw.",
    updated_at,
    currency: "EUR",
    prices: pricingData,
  };

  if (didChange) {
    fs.writeFileSync("./prices.json", JSON.stringify(json, null, 2));
    fs.writeFileSync("./prices.min.json", JSON.stringify(json));
  } else {
    console.log("No new price data available");
    core.notice("No new price data available");
  }
} catch (error) {
  console.error(error);
  core.setFailed(error.message);
}
