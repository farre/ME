"use strict";
const base = "https://bugzilla.mozilla.org/";
const now = Date.now();

function query(o) {
  return Object.keys(o).map((k) => `${k}=${encodeURIComponent(o[k])}`);
}

class Period {
  static week = new Date(0).setDate(7).valueOf();

  constructor(chfield, num_weeks) {
    const week = new Date(0).setDate(7).valueOf();
    this.chfield = chfield;
    this.chfieldfrom = new Date(now - week * num_weeks).toISOString();
    this.chfieldto = new Date(now).toISOString();
  }
}

async function rest(endpoint, params) {
  const uri = new URL(`rest/${endpoint}`, base);
  params = params ?? "";
  if (params instanceof Array) {
    params = params.flatMap((value) => {
      if (typeof value !== "object") {
        return value;
      }
      return query(value);
    });
  } else if (typeof params === "object") {
    params = query(params);
  } else {
    params = [encodeURIComponent(params)];
  }

  uri.search = params.join("&");
  const response = await fetch(uri);
  return await response.json();
}

async function* search(params, limit) {
  let offset = 0;
  async function* helper() {
    while (true) {
      yield await rest("bug", [{ offset }, { limit }, ...params]);
      offset += limit;
    }
  }

  let result = [];
  for await (const { bugs } of helper()) {
    for (const bug of bugs) {
      yield bug;
    }

    if (bugs.length < limit) {
      break;
    }
  }
}

const products = ["Core", "Toolkit"].map((product) => {
  return { product };
});

const components = [
  "about:memory",
  "Cycle Collector",
  "DOM: Bindings (WebIDL)",
  "DOM: Copy & Paste and Drag & Drop",
  "DOM: Core & HTML",
  "DOM: Editor",
  "DOM: Events",
  "DOM: Forms",
  "DOM: Geolocation",
  "DOM: HTML Parser",
  "DOM: Navigation",
  "DOM: Selection",
  "DOM: Serializers",
  "DOM: UI Events & Focus Handling",
  "DOM: Window and Location",
  "XML",
  "XPConnect",
  "XSLT",
].map((component) => {
  return { component };
});

async function* opened(num_weeks) {
  const query_format = "advanced";
  const period = new Period("[Bug creation]", num_weeks);
  const include_fields = "severity";
  const bug_type = "defect";
  yield* search(
    [
      { query_format },
      period,
      { include_fields },
      { bug_type },
      { include_fields },
      ...products,
      ...components,
    ],
    500
  );
}

async function* total_open() {
  const query_format = "advanced";
  const include_fields = "severity";
  const bug_type = "defect";
  const f1 = "resolution";
  const resolution = "---";
  const o1 = "empty";
  yield* search(
    [
      { query_format },
      { include_fields },
      { f1, resolution, o1 },
      { bug_type },
      { include_fields },
      ...products,
      ...components,
    ],
    500
  );
}

async function* closed(num_weeks) {
  const query_format = "advanced";
  const period = new Period("cf_last_resolved", num_weeks);
  const include_fields = "severity";
  const bug_type = "defect";
  const f1 = "resolution";
  const v1 = "---";
  yield* search(
    [
      { query_format },
      period,
      { include_fields },
      { bug_type },
      { f1 },
      { v1 },
      ...products,
      ...components,
    ],
    500
  );
}

class ME {
  static #weight(severity) {
    switch (severity) {
      case "S1":
        return 8;
      case "S2":
        return 5;
      case "S3":
        return 2;
      case "S4":
        return 1;
      default:
        return 3;
    }
  }

  static async #process_result(results) {
    let S1 = 0;
    let S2 = 0;
    let S3 = 0;
    let S4 = 0;
    let UNTRIAGED = 0;
    let weighted_result = 0;
    let result = 0;

    results = await results;

    result = results.length;

    for (const entry of results) {
      switch (entry.severity) {
        case "S1":
          ++S1;
          break;
        case "S2":
          ++S2;
          break;
        case "S3":
          ++S3;
          break;
        case "S4":
          ++S4;
          break;
        default:
          ++UNTRIAGED;
          break;
      }
    }

    weighted_result = S1 * 8 + S2 * 5 + S3 * 2 + S4 + UNTRIAGED * 3;
    return { S1, S2, S3, S4, "--": UNTRIAGED, result, weighted_result };
  }

  static #get_result(results, callback, weeks) {
    const result = results.find((result) => result.weeks === weeks);
    if (result) {
      return result.defects;
    }

    const entry = {
      weeks,
      defects: this.#process_result(Array.fromAsync(callback(weeks))),
    };
    results.push(entry);
    return entry.defects;
  }

  #open = [];
  #closed = [];
  #opened = [];

  constructor() {}

  async open_defects(severity) {
    if (!severity) {
      return (await ME.#get_result(this.#open, total_open, Infinity)).result;
    }

    return (await ME.#get_result(this.#open, total_open, Infinity))[severity];
  }

  async closed_defects(weeks, severity) {
    if (!severity) {
      return (await ME.#get_result(this.#closed, closed, weeks)).result;
    }

    return (await ME.#get_result(this.#closed, closed, weeks))[severity];
  }

  async opened_defects(weeks, severity) {
    if (!severity) {
      return (await ME.#get_result(this.#opened, opened, weeks)).result;
    }

    return (await ME.#get_result(this.#opened, opened, weeks))[severity];
  }

  async weighted_open_defects() {
    return (await ME.#get_result(this.#open, total_open, Infinity))
      .weighted_result;
  }

  async weighted_closed_defects(weeks) {
    return (await ME.#get_result(this.#closed, closed, weeks)).weighted_result;
  }

  async weighted_opened_defects(weeks) {
    return (await ME.#get_result(this.#opened, opened, weeks)).weighted_result;
  }

  async maintenance_effectiveness(weeks) {
    const [opened, closed] = await Promise.all([
      this.weighted_opened_defects(weeks),
      this.weighted_closed_defects(weeks),
    ]);

    if (opened > 0) {
      const me = closed / opened;
      return me.toPrecision(me < 1 ? 2 : 3);
    }

    return closed + 1;
  }

  async weighted_burn_down_time(weeks) {
    const [open, me, opened, closed] = await Promise.all([
      this.weighted_open_defects(),
      this.maintenance_effectiveness(weeks),
      this.weighted_opened_defects(weeks),
      this.weighted_closed_defects(weeks),
    ]);

    if (me > 1) {
      return ((open / (closed - opened)) * (weeks / 52)).toPrecision(3);
    }

    return 1 / 0;
  }
}
