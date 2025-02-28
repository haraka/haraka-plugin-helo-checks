'use strict'
// Check various bits of the HELO string
const dns = require('node:dns')

const tlds = require('haraka-tld')
const net_utils = require('haraka-net-utils')
const utils = require('haraka-utils')

const checks = [
  'match_re', // List of regexps
  'bare_ip', // HELO is bare IP (vs required Address Literal)
  'dynamic', // HELO hostname looks dynamic (dsl|dialup|etc...)
  'big_company', // Well known HELOs that must match rdns
  'valid_hostname', // HELO hostname is a legal DNS name
  'rdns_match', // HELO hostname matches rDNS
  'forward_dns', // HELO hostname resolves to the connecting IP
  'host_mismatch', // hostname differs between invocations
  // literal_mismatch
]

exports.register = function () {
  this.load_helo_checks_ini()

  if (this.cfg.check.proto_mismatch) {
    // NOTE: these *must* run before init
    this.register_hook('helo', 'proto_mismatch_smtp')
    this.register_hook('ehlo', 'proto_mismatch_esmtp')
  }

  // Always run init
  this.register_hook('helo', 'init')
  this.register_hook('ehlo', 'init')

  for (const c of checks) {
    if (!this.cfg.check[c]) continue // disabled in config
    this.register_hook('helo', c)
    this.register_hook('ehlo', c)
  }

  // IP literal that doesn't match remote IP
  this.register_hook('helo', 'literal_mismatch')
  this.register_hook('ehlo', 'literal_mismatch')

  // Always emit a log entry
  this.register_hook('helo', 'emit_log')
  this.register_hook('ehlo', 'emit_log')

  if (this.cfg.check.match_re) {
    const load_re_file = () => {
      const regex_list = utils.valid_regexes(
        this.config.get('helo.checks.regexps', 'list', load_re_file),
      )
      // pre-compile the regexes
      this.cfg.list_re = new RegExp(`^(${regex_list.join('|')})$`, 'i')
    }
    load_re_file()
  }
}

exports.load_helo_checks_ini = function () {
  const booleans = [
    '+skip.private_ip',
    '+skip.whitelist',
    '+skip.relaying',

    '-reject.literal_mismatch',
    '+check.proto_mismatch',
    '-reject.proto_mismatch',
  ]

  for (const c of checks) {
    booleans.push(`+check.${c}`)
    booleans.push(`-reject.${c}`)
  }

  this.cfg = this.config.get('helo.checks.ini', { booleans }, () => {
    this.load_helo_checks_ini()
  })

  this.cfg.check.literal_mismatch = this.cfg.check.literal_mismatch ?? 2

  // backwards compatible with old config file
  if (this.cfg.check_no_dot !== undefined) {
    this.cfg.check.valid_hostname = !!this.cfg.check_no_dot
  }
  if (this.cfg.check_dynamic !== undefined) {
    this.cfg.check.dynamic = !!this.cfg.check_dynamic
  }
  if (this.cfg.check_raw_ip !== undefined) {
    this.cfg.check.bare_ip = !!this.cfg.check_raw_ip
  }

  // non-default setting, so apply their localized setting
  if (
    this.cfg.check.mismatch !== undefined &&
    this.cfg.check.mismatch === undefined
  ) {
    this.logerror('deprecated setting mismatch renamed to host_mismatch')
    this.cfg.check.host_mismatch = this.cfg.check.mismatch
  }
  if (this.cfg.reject.mismatch !== undefined && this.cfg.reject.mismatch) {
    this.logerror('deprecated setting mismatch renamed to host_mismatch')
    this.cfg.reject.host_mismatch = this.cfg.reject.mismatch
  }
}

exports.init = function (next, connection, helo) {
  if (!connection.results.has('helo.checks', 'helo_host', helo)) {
    connection.results.add(this, { helo_host: helo })
  }

  next()
}

exports.should_skip = function (connection, test_name) {
  if (
    connection.hello.host &&
    connection.results.has('helo.checks', '_skip_hooks', test_name)
  ) {
    this.logdebug(connection, `SKIPPING: ${test_name}`)
    return true
  }
  connection.results.push(this, { _skip_hooks: test_name })

  if (this.cfg.skip.relaying && connection.relaying) {
    connection.results.add(this, { skip: `${test_name}(relay)` })
    return true
  }

  if (this.cfg.skip.private_ip && connection.remote.is_private) {
    connection.results.add(this, { skip: `${test_name}(private)` })
    return true
  }

  return false
}

exports.host_mismatch = function (next, connection, helo) {
  if (this.should_skip(connection, 'host_mismatch')) return next()

  const prev_helo = connection.results.get('helo.checks').helo_host
  if (!prev_helo) {
    connection.results.add(this, { skip: 'host_mismatch(1st)' })
    return next()
  }

  if (prev_helo === helo) {
    connection.results.add(this, { pass: 'host_mismatch' })
    return next()
  }

  const msg = `host_mismatch(${prev_helo} / ${helo})`
  connection.results.add(this, { fail: msg })
  if (!this.cfg.reject.host_mismatch) return next()

  next(DENY, `HELO host ${msg}`)
}

exports.valid_hostname = function (next, connection, helo) {
  if (this.should_skip(connection, 'valid_hostname')) return next()

  if (net_utils.is_ip_literal(helo)) {
    connection.results.add(this, { skip: 'valid_hostname(literal)' })
    return next()
  }

  if (!/\./.test(helo)) {
    connection.results.add(this, { fail: 'valid_hostname(no_dot)' })
    if (this.cfg.reject.valid_hostname) {
      return next(
        DENY,
        'HELO host must be a FQDN or address literal (RFC 5321 2.3.5)',
      )
    }
    return next()
  }

  // this will fail if TLD is invalid or hostname is a public suffix
  if (!tlds.get_organizational_domain(helo)) {
    // Check for any excluded TLDs
    const excludes = this.config.get('helo.checks.allow', 'list')
    const tld = helo.split(/\./).reverse()[0].toLowerCase()
    // Exclude .local, .lan and .corp
    if (
      tld === 'local' ||
      tld === 'lan' ||
      tld === 'corp' ||
      excludes.includes(`.${tld}`)
    ) {
      return next()
    }
    connection.results.add(this, { fail: 'valid_hostname' })
    if (this.cfg.reject.valid_hostname) {
      return next(DENY, 'HELO host name invalid')
    }
    return next()
  }

  connection.results.add(this, { pass: 'valid_hostname' })
  next()
}

exports.match_re = function (next, connection, helo) {
  if (this.should_skip(connection, 'match_re')) return next()

  if (this.cfg.list_re?.test(helo)) {
    connection.results.add(this, { fail: 'match_re' })
    if (this.cfg.reject.match_re) {
      return next(DENY, 'That HELO not allowed here')
    }
    return next()
  }
  connection.results.add(this, { pass: 'match_re' })
  next()
}

exports.rdns_match = function (next, connection, helo) {
  if (this.should_skip(connection, 'rdns_match')) return next()

  if (!helo) {
    connection.results.add(this, { fail: 'rdns_match(empty)' })
    return next()
  }

  if (net_utils.is_ip_literal(helo)) {
    connection.results.add(this, { fail: 'rdns_match(literal)' })
    return next()
  }

  const r_host = connection.remote.host
  if (r_host && helo === r_host) {
    connection.results.add(this, { pass: 'rdns_match' })
    return next()
  }

  if (
    tlds.get_organizational_domain(r_host) ===
    tlds.get_organizational_domain(helo)
  ) {
    connection.results.add(this, { pass: 'rdns_match(org_dom)' })
    return next()
  }

  connection.results.add(this, { fail: 'rdns_match' })
  if (this.cfg.reject.rdns_match) {
    return next(DENY, 'HELO host does not match rDNS')
  }
  next()
}

exports.bare_ip = function (next, connection, helo) {
  if (this.should_skip(connection, 'bare_ip')) return next()

  // RFC 2821, 4.1.1.1  Address literals must be in brackets
  // RAW IPs must be formatted: "[1.2.3.4]" not "1.2.3.4" in HELO
  if (net_utils.get_ipany_re('^(?:IPv6:)?', '$', '').test(helo)) {
    connection.results.add(this, { fail: 'bare_ip(invalid literal)' })
    if (this.cfg.reject.bare_ip) {
      return next(DENY, 'Invalid address format in HELO')
    }
    return next()
  }

  connection.results.add(this, { pass: 'bare_ip' })
  next()
}

exports.dynamic = function (next, connection, helo) {
  if (this.should_skip(connection, 'dynamic')) return next()

  // Skip if no dots or an IP literal or address
  if (!/\./.test(helo)) {
    connection.results.add(this, { skip: 'dynamic(no dots)' })
    return next()
  }

  if (net_utils.get_ipany_re('^\\[?(?:IPv6:)?', '\\]?$', '').test(helo)) {
    connection.results.add(this, { skip: 'dynamic(literal)' })
    return next()
  }

  if (net_utils.is_ip_in_str(connection.remote.ip, helo)) {
    connection.results.add(this, { fail: 'dynamic' })
    if (this.cfg.reject.dynamic) {
      return next(DENY, 'HELO is dynamic')
    }
    return next()
  }

  connection.results.add(this, { pass: 'dynamic' })
  next()
}

exports.big_company = function (next, connection, helo) {
  if (this.should_skip(connection, 'big_company')) return next()

  if (net_utils.is_ip_literal(helo)) {
    connection.results.add(this, { skip: 'big_co(literal)' })
    return next()
  }

  if (!this.cfg.bigco) {
    connection.results.add(this, { err: 'big_co(config missing)' })
    return next()
  }

  if (!this.cfg.bigco[helo]) {
    connection.results.add(this, { pass: 'big_co(not)' })
    return next()
  }

  const rdns = connection.remote.host
  if (!rdns || rdns === 'Unknown' || rdns === 'DNSERROR') {
    connection.results.add(this, { fail: 'big_co(rDNS)' })
    if (this.cfg.reject.big_company) {
      return next(DENY, 'Big company w/o rDNS? Unlikely.')
    }
    return next()
  }

  const allowed_rdns = this.cfg.bigco[helo].split(/,/)
  for (const allow of allowed_rdns) {
    const re = new RegExp(`${allow.replaceAll('.', '\\.')}$`)
    if (re.test(rdns)) {
      connection.results.add(this, { pass: 'big_co' })
      return next()
    }
  }

  connection.results.add(this, { fail: 'big_co' })
  if (this.cfg.reject.big_company) {
    return next(DENY, 'You are not who you say you are')
  }
  next()
}

exports.literal_mismatch = function (next, connection, helo) {
  if (this.should_skip(connection, 'literal_mismatch')) return next()

  const literal = net_utils
    .get_ipany_re('^\\[(?:IPv6:)?', '\\]$', '')
    .exec(helo)
  if (!literal) {
    connection.results.add(this, { pass: 'literal_mismatch' })
    return next()
  }

  const lmm_mode = parseInt(this.cfg.check.literal_mismatch, 10)
  const helo_ip = literal[1]
  if (lmm_mode > 2 && net_utils.is_private_ip(helo_ip)) {
    connection.results.add(this, { pass: 'literal_mismatch(private)' })
    return next()
  }

  if (lmm_mode > 1) {
    if (net_utils.same_ipv4_network(connection.remote.ip, [helo_ip])) {
      connection.results.add(this, { pass: 'literal_mismatch' })
      return next()
    }

    connection.results.add(this, { fail: 'literal_mismatch' })
    if (this.cfg.reject.literal_mismatch === true) {
      return next(
        DENY,
        'HELO IP literal not in the same /24 as your IP address',
      )
    }
    return next()
  }

  if (helo_ip === connection.remote.ip) {
    connection.results.add(this, { pass: 'literal_mismatch' })
    return next()
  }

  connection.results.add(this, { fail: 'literal_mismatch' })
  if (this.cfg.reject.literal_mismatch === true) {
    return next(DENY, 'HELO IP literal does not match your IP address')
  }
  next()
}

exports.forward_dns = function (next, connection, helo) {
  if (this.should_skip(connection, 'forward_dns')) return next()
  if (!this.cfg.check.valid_hostname) {
    connection.results.add(this, {
      err: 'forward_dns(valid_hostname disabled)',
    })
    return next()
  }

  if (net_utils.is_ip_literal(helo)) {
    connection.results.add(this, { skip: 'forward_dns(literal)' })
    return next()
  }

  if (!connection.results.has('helo.checks', 'pass', /^valid_hostname/)) {
    connection.results.add(this, { fail: 'forward_dns(invalid_hostname)' })
    if (this.cfg.reject.forward_dns) {
      return next(DENY, 'Invalid HELO host cannot achieve forward DNS match')
    }
    return next()
  }

  this.get_a_records(helo)
    .then((ips) => {
      if (!ips) {
        connection.results.add(this, { err: 'forward_dns, no ips!' })
        return next()
      }
      connection.results.add(this, { ips: ips })

      if (ips.includes(connection.remote.ip)) {
        connection.results.add(this, { pass: 'forward_dns' })
        return next()
      }

      // some valid hosts (facebook.com, hotmail.com) use a generic HELO
      // hostname that resolves but doesn't contain the IP that is
      // connecting. If their rDNS passed, and their HELO hostname is in
      // the same domain, consider it close enough.
      if (connection.results.has('helo.checks', 'pass', /^rdns_match/)) {
        const helo_od = tlds.get_organizational_domain(helo)
        const rdns_od = tlds.get_organizational_domain(connection.remote.host)
        if (helo_od && helo_od === rdns_od) {
          connection.results.add(this, { pass: 'forward_dns(domain)' })
          return next()
        }
        connection.results.add(this, { msg: `od miss: ${helo_od}, ${rdns_od}` })
      }

      connection.results.add(this, { fail: 'forward_dns(no IP match)' })
      if (this.cfg.reject.forward_dns) {
        return next(DENY, 'HELO host has no forward DNS match')
      }
      next()
    })
    .catch((err) => {
      if (
        err.code === dns.NOTFOUND ||
        err.code === dns.NODATA ||
        err.code === dns.SERVFAIL
      ) {
        connection.results.add(this, { fail: `forward_dns(${err.code})` })
        return next()
      }
      if (err.code === dns.TIMEOUT && this.cfg.reject.forward_dns) {
        connection.results.add(this, { fail: `forward_dns(${err.code})` })
        return next(DENYSOFT, 'DNS timeout resolving your HELO hostname')
      }
      connection.results.add(this, {
        err: `forward_dns(${err})`,
        emit_log_level: 'warn',
      })
      next()
    })
}

exports.proto_mismatch = function (next, connection, helo, proto) {
  if (this.should_skip(connection, 'proto_mismatch')) return next()

  const r = connection.results.get('helo.checks')
  if (!r || (r && !r.helo_host)) return next()

  if (
    (connection.esmtp && proto === 'smtp') ||
    (!connection.esmtp && proto === 'esmtp')
  ) {
    connection.results.add(this, { fail: `proto_mismatch(${proto})` })
    if (this.cfg.reject.proto_mismatch) {
      return next(
        DENY,
        `${proto === 'smtp' ? 'HELO' : 'EHLO'} protocol mismatch`,
      )
    }
  }

  next()
}

exports.proto_mismatch_smtp = function (next, connection, helo) {
  this.proto_mismatch(next, connection, helo, 'smtp')
}

exports.proto_mismatch_esmtp = function (next, connection, helo) {
  this.proto_mismatch(next, connection, helo, 'esmtp')
}

exports.emit_log = function (next, connection, helo) {
  // Spits out an INFO log entry. Default looks like this:
  // [helo.checks] helo_host: [182.212.17.35], fail:big_co(rDNS) rdns_match(literal), pass:valid_hostname, match_re, bare_ip, literal_mismatch, mismatch, skip:dynamic(literal), valid_hostname(literal)
  //
  // Although sometimes useful, that's a bit verbose. I find that I'm rarely
  // interested in the passes, the helo_host is already logged elsewhere,
  // and so I set this in config/results.ini:
  //
  // [helo.checks]
  // order=fail,pass,msg,err,skip
  // hide=helo_host,multi,pass
  //
  // Thus set, my log entries look like this:
  //
  // [UUID] [helo.checks] fail:rdns_match
  // [UUID] [helo.checks]
  // [UUID] [helo.checks] fail:dynamic
  connection.loginfo(this, connection.results.collate(this))
  next()
}

exports.get_a_records = async function (host) {
  if (!/\./.test(host)) {
    // a single label is not a host name
    const e = new Error('invalid hostname')
    e.code = dns.NOTFOUND
    throw e
  }

  // fully qualify, to ignore any search options in /etc/resolv.conf
  if (!/\.$/.test(host)) host = `${host}.`

  // do the queries
  let ips
  let err = ''
  try {
    ips = await net_utils.get_ips_by_host(host)
  } catch (errs) {
    for (const error of errs) {
      switch (error.code) {
        case dns.NODATA:
        case dns.NOTFOUND:
        case dns.SERVFAIL:
          continue
        default:
          err = `${err}, ${error.message}`
      }
    }
  }

  // results is now equals to: {queryA: 1, queryAAAA: 2}
  if (!ips.length && err) throw err
  // this.logdebug(this, host + ' => ' + ips);
  // return the DNS results
  return ips
}
