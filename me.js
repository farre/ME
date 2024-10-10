"use strict";
const base = "https://bugzilla.mozilla.org/";
const now = Date.now();

function encode_query_string(o) {
  return Object.keys(o).map((k) => `${k}=${encodeURIComponent(o[k])}`);
}

class Period {
  constructor(chfield, num_weeks) {
    const week = new Date(0).setDate(8).valueOf();
    this.chfield = chfield;
    this.chfieldfrom = new Date(now - week * num_weeks).toISOString();
    this.chfieldto = new Date(now).toISOString();
  }
}

const team_name = "DOM Core";
const query_format = "advanced";
const include_fields = "severity";
const bug_type = "defect";
const f1 = "resolution";

const header = { query_format, bug_type, include_fields, team_name };

function opened(num_weeks) {
  const period = new Period("[Bug creation]", num_weeks);
  return [header, period];
}

function total_open() {
  const resolution = "---";
  const o1 = "empty";
  return [header, { f1, resolution, o1 }];
}

function closed(num_weeks) {
  const period = new Period("cf_last_resolved", num_weeks);
  const v1 = "---";
  const o1 = "notequals";
  return [header, { f1, o1, v1 }, period];
}

function query_string(params) {
  params = params ?? "";
  if (params instanceof Array) {
    params = params.flatMap((value) => {
      if (typeof value !== "object") {
        return value;
      }
      return encode_query_string(value);
    });
  } else if (typeof params === "object") {
    params = encode_query_string(params);
  } else {
    params = [encodeURIComponent(params)];
  }

  return params.join("&");
}

async function rest(endpoint, signal, params) {
  const uri = new URL(`rest/${endpoint}`, base);
  uri.search = query_string(params);
  const response = await fetch(uri, { signal });
  return await response.json();
}

function create_link(params) {
  const uri = new URL("buglist.cgi", base);
  uri.search = query_string(params);
  return uri.href;
}

function formatting(severity) {
  const label = severity ?? "result";
  const discriminator = severity
    ? `f2=bug_severity&o2=equals&v2=${severity}`
    : "";
  return { label, discriminator };
}

class ME {
  async *#search(params, limit) {
    let offset = 0;
    const signal = this.#controller.signal;
    async function* helper() {
      while (true) {
        yield await rest("bug", signal, [{ offset, limit }, ...params]);
        offset += limit;
      }
    }

    for await (const { bugs } of helper()) {
      for (const bug of bugs) {
        yield bug;
      }

      if (bugs.length < limit) {
        break;
      }
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

  #get_result(results, callback, weeks) {
    const result = results.find((result) => result.weeks === weeks);
    if (result) {
      return result;
    }

    const input = callback(weeks);

    const entry = {
      weeks,
      defects: ME.#process_result(Array.fromAsync(this.#search(input, 500))),
      link: create_link(input),
    };
    results.push(entry);
    return entry;
  }

  #open = [];
  #closed = [];
  #opened = [];
  #controller = new AbortController();

  constructor() {}

  async #run(results, callback, weeks, severity) {
    const { defects, link } = this.#get_result(results, callback, weeks);
    const { label, discriminator } = formatting(severity);
    const result = await defects;
    return `<a href="${link}&${discriminator}">${result[label]}</a>`;
  }

  async #run2(results, callback, weeks) {
    const { defects } = this.#get_result(results, callback, weeks);
    const result = await defects;
    return result.weighted_result;
  }

  open_defects(severity) {
    return this.#run(this.#open, total_open, Infinity);
  }

  closed_defects(weeks, severity) {
    return this.#run(this.#closed, closed, weeks, severity);
  }

  async opened_defects(weeks, severity) {
    return this.#run(this.#opened, opened, weeks, severity);
  }

  async weighted_open_defects() {
    return this.#run2(this.#open, total_open, Infinity);
  }

  async weighted_closed_defects(weeks) {
    return this.#run2(this.#closed, closed, weeks);
  }

  async weighted_opened_defects(weeks) {
    return this.#run2(this.#opened, opened, weeks);
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

  abort() {
    this.#controller.abort();
  }
}
