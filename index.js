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
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.7,nl;q=0.3",
  "Accept-Encoding": "gzip, deflate, br",
  Origin: "https://vrijopnaam.app",
  DNT: "1",
  Referer: loginUrl,
  Connection: "keep-alive",
};

const parseCookies = (entries) => {
  if (!entries || !entries.length) return "";

  const jar = new Map();
  entries.forEach((entry) => {
    const [name, value] = entry.split(";")[0].split("=");
    if (name && value) jar.set(name.trim(), value.trim());
  });

  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
};

async function login() {
  console.log("Starting login process...");
  const response = await fetch(loginUrl, { headers: defaultHeaders });
  console.log(`Login page response: ${response.status} ${response.statusText}`);
  const body = await response.text();
  console.log(`Login page body length: ${body.length} chars`);
  const $ = cheerio.load(body);
  const csrfToken = $('input[name="csrfmiddlewaretoken"]').val();
  console.log(`CSRF token found: ${csrfToken ? "yes" : "no"}`);
  const initialCookies = response.headers.getSetCookie();
  console.log(`Initial cookies: ${initialCookies.length} set`);

  const passwordFromPage = $(".centered b")
    .filter((i, el) => {
      const text = $(el).text().trim();
      return text.length > 5 && text.length < 20;
    })
    .first()
    .text()
    .trim();

  if (!passwordFromPage) {
    throw new Error("Password not found on login page");
  }

  console.log(`Password extracted from page: "${passwordFromPage}"`);

  const cookieHeader = parseCookies(initialCookies);
  const headers = {
    ...defaultHeaders,
    Referer: loginUrl,
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: `${cookieHeader}; csrftoken=${csrfToken}`,
  };

  const postData = new URLSearchParams({
    csrfmiddlewaretoken: csrfToken,
    code: passwordFromPage,
    show_dynamic_pricing: "on",
    username: "",
    password: "",
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  const response2 = await fetch(loginUrl, {
    method: "POST",
    headers,
    body: postData.toString(),
    redirect: "manual",
  });
  console.log(
    `Login POST response: ${response2.status} ${response2.statusText}`
  );
  const location = response2.headers.get("location");
  if (location) console.log(`Login redirect location: ${location}`);
  const loginBody = await response2.text();
  console.log(`Login POST body length: ${loginBody.length} chars`);
  const $2 = cheerio.load(loginBody);
  const hasError = $2(".error, .alert-error, .form-error").length > 0;
  if (hasError) {
    const errorText = $2(".error, .alert-error, .form-error").text().trim();
    console.log(`Login error detected: ${errorText}`);
  }

  const loginCookies = response2.headers.getSetCookie();
  console.log(`Login cookies: ${loginCookies.length} set`);
  const mergedCookies = parseCookies([
    ...(initialCookies || []),
    ...(loginCookies || []),
  ]);
  console.log(`Login complete, merged cookies length: ${mergedCookies.length}`);

  return mergedCookies;
}

async function fetchPricing(cookieHeader) {
  console.log("Fetching pricing page...");
  const response = await fetch(pricingUrl, {
    headers: {
      ...defaultHeaders,
      Cookie: cookieHeader,
    },
    redirect: "follow",
  });
  console.log(
    `Pricing page response: ${response.status} ${response.statusText}`
  );
  const body = await response.text();
  console.log(`Pricing page body length: ${body.length} chars`);
  console.log(`Pricing page preview: ${body.slice(0, 200)}`);

  const $ = cheerio.load(body);

  const pricingRows = $(".pricing-table tbody tr").length;
  console.log(`Pricing table rows found: ${pricingRows}`);

  if (pricingRows === 0) {
    const pageTitle = $("title").text();
    const hasLoginForm = $('input[name="csrfmiddlewaretoken"]').length > 0;
    console.log(`Page title: ${pageTitle}`);
    console.log(`Has login form: ${hasLoginForm}`);
    throw new Error("No pricing data found");
  }

  const hasTomorrow = $(
    '.pricing-chart-title[data-title-day="tomorrow"]'
  ).length;
  const hasYesterday = $(
    '.pricing-chart-title[data-title-day="yesterday"]'
  ).length;
  console.log(`Has tomorrow: ${hasTomorrow}, has yesterday: ${hasYesterday}`);

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

  console.log(`Extracted ${prices.length} price entries`);
  console.log("First price:", prices[0]);
  console.log("Last price:", prices[prices.length - 1]);
  return prices;
}

try {
  const cookies = await login();
  const pricingData = await fetchPricing(cookies);

  let previousPrices = [];
  try {
    const parsed = JSON.parse(fs.readFileSync("./prices.json"));
    previousPrices = parsed.prices || [];
  } catch (_e) {}

  const sameData =
    previousPrices.length === pricingData.length &&
    JSON.stringify(previousPrices) === JSON.stringify(pricingData);

  const updated_at = new Date();
  const json = {
    source: "Vrij op naam",
    description:
      "All-in-prijs: dit is de kale inkoopprijs zoals deze op de stroombeurs geldt, plus de inkoopvergoeding, energiebelasting en ODE (1ste staffel), inclusief btw.",
    updated_at,
    currency: "EUR",
    prices: pricingData,
  };

  if (sameData) {
    console.log("Prices unchanged; files left intact");
    core.notice("Prices unchanged; files left intact");
  } else {
    console.log(`Writing ${pricingData.length} price entries to files`);
    fs.writeFileSync("./prices.json", JSON.stringify(json, null, 2) + "\n");
    fs.writeFileSync("./prices.min.json", JSON.stringify(json) + "\n");
  }
} catch (error) {
  console.error("Error details:", error.message);
  console.error("Error stack:", error.stack);
  core.setFailed(error.message);
}
