/* eslint-disable */
const request = require('request-promise')
const fs = require('fs')
const fspath = require('path')
const PromisePool = require('es6-promise-pool')
const singleLineLog = require('single-line-log')

const Log = singleLineLog.stdout;

const BASE_SENTRY_URL = 'https://sentry.io/api/0'

const DEFAULT_INCLUDE = /\.js$|\.map$/
const DEFAULT_TRANSFORM = filename => `~/${filename}`
const DEFAULT_DELETE_REGEX = /\.map$/
const DEFAULT_BODY_TRANSFORM = (version, projects) => ({ version, projects })
const DEFAULT_UPLOAD_FILES_CONCURRENCY = Infinity
const DEFAULT_REQ_TIMEOUT = 1000 * 60

const timers = new Set()

module.exports = class SentryPlugin {
  constructor(options) {
    // The baseSentryURL option was previously documented to have
    // `/projects` on the end. We now expect the basic API endpoint
    // but remove any `/projects` suffix for backwards compatibility.
    const projectsRegex = /\/projects$/
    if (options.baseSentryURL) {
      if (projectsRegex.test(options.baseSentryURL)) {
        // eslint-disable-next-line no-console
        console.warn(
          "baseSentryURL with '/projects' suffix is deprecated; " +
          'see https://github.com/40thieves/webpack-sentry-plugin/issues/38',
        )
        this.baseSentryURL = options.baseSentryURL.replace(projectsRegex, '')
      }
      else {
        this.baseSentryURL = options.baseSentryURL
      }
    }
    else {
      this.baseSentryURL = BASE_SENTRY_URL
    }

    this.reqTimeout = options.timeout || DEFAULT_REQ_TIMEOUT;

    this.organizationSlug = options.organization || options.organisation
    this.projectSlug = options.project
    if (typeof this.projectSlug === 'string') {
      this.projectSlug = [this.projectSlug]
    }
    this.apiKey = options.apiKey

    this.releaseBody = options.releaseBody || DEFAULT_BODY_TRANSFORM
    this.releaseVersion = options.release

    this.include = options.include || DEFAULT_INCLUDE
    this.exclude = options.exclude

    this.filenameTransform = options.filenameTransform || DEFAULT_TRANSFORM
    this.suppressErrors = options.suppressErrors
    this.suppressConflictError = options.suppressConflictError
    this.createReleaseRequestOptions =
      options.createReleaseRequestOptions || options.requestOptions || {}
    if (typeof this.createReleaseRequestOptions === 'object') {
      const createReleaseRequestOptions = this.createReleaseRequestOptions
      this.createReleaseRequestOptions = () => createReleaseRequestOptions
    }
    this.uploadFileRequestOptions =
      options.uploadFileRequestOptions || options.requestOptions || {}
    if (typeof this.uploadFileRequestOptions === 'object') {
      const uploadFileRequestOptions = this.uploadFileRequestOptions
      this.uploadFileRequestOptions = () => uploadFileRequestOptions
    }
    if (options.requestOptions) {
      // eslint-disable-next-line no-console
      console.warn(
        'requestOptions is deprecated. ' +
        'use createReleaseRequestOptions and ' +
        'uploadFileRequestOptions instead; ' +
        'see https://github.com/40thieves/webpack-sentry-plugin/pull/43'
      )
    }

    this.deleteAfterCompile = options.deleteAfterCompile
    this.deleteRegex = options.deleteRegex || DEFAULT_DELETE_REGEX
    this.uploadFilesConcurrency =
      options.uploadFilesConcurrency || DEFAULT_UPLOAD_FILES_CONCURRENCY
  }

  apply(compiler) {
    compiler.hooks.done.tapAsync('SentryPlus', (stats, cb) => {
      const { compilation } = stats;
      const errors = this.ensureRequiredOptions()

      if (errors) {
        return this.handleErrors(errors, compilation, cb)
      }

      const files = this.getFiles(compilation)

      if (typeof this.releaseVersion === 'function') {
        this.releaseVersion = this.releaseVersion(compilation.hash)
      }

      if (typeof this.releaseBody === 'function') {
        this.releaseBody = this.releaseBody(
          this.releaseVersion,
          this.projectSlug,
        )
      }

      return this.createRelease()
        .then(() => this.uploadFiles(files))
        .then(() => {
          [...timers].forEach(t => clearTimeout(t))
        })
        .then(() => {
          if (this.deleteAfterCompile) {
            this.deleteFiles(stats)
          }
        })
        .then(() => cb())
        .catch(err => this.handleErrors(err, compilation, cb))
    })
  }

  handleErrors(err, compilation, cb) {
    const errorMsg = `Sentry Plugin: ${err}`
    if (
      this.suppressErrors ||
      (this.suppressConflictError && err.statusCode === 409)
    ) {
      compilation.warnings.push(errorMsg)
    }
    else {
      compilation.errors.push(errorMsg)
    }

    cb()
  }

  ensureRequiredOptions() {
    if (!this.organizationSlug) {
      return new Error('Must provide organization')
    }
    else if (!this.projectSlug) {
      return new Error('Must provide project')
    }
    else if (!this.apiKey) {
      return new Error('Must provide api key')
    }
    else if (!this.releaseVersion) {
      return new Error('Must provide release version')
    }
    else {
      return null
    }
  }

  getFiles(compilation) {
    return Object.keys(compilation.assets)
      .map((name) => {
        if (this.isIncludeOrExclude(name)) {
          return { name, path: fspath.join(compilation.outputOptions.path, name) }
        }
        return null
      })
      .filter(i => i)
  }

  isIncludeOrExclude(filename) {
    const isIncluded = this.include ? this.include.test(filename) : true
    const isExcluded = this.exclude ? this.exclude.test(filename) : false

    return isIncluded && !isExcluded
  }

  // eslint-disable-next-line class-methods-use-this
  combineRequestOptions(req, requestOptionsFunc) {
    const requestOptions = requestOptionsFunc(req)
    const combined = Object.assign({}, requestOptions, req)
    if (requestOptions.headers) {
      Object.assign(combined.headers, requestOptions.headers, req.headers)
    }
    if (requestOptions.auth) {
      Object.assign(combined.auth, requestOptions.auth, req.auth)
    }
    return combined
  }

  createRelease() {
    return request(
      this.combineRequestOptions(
        {
          url: `${this.sentryReleaseUrl()}/`,
          method: 'POST',
          auth: {
            bearer: this.apiKey,
          },
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(this.releaseBody),
        },
        this.createReleaseRequestOptions,
      ),
    )
  }

  uploadFiles(files) {
    const pool = new PromisePool(() => {
      const file = files.pop()
      if (!file) {
        return null
      }
      return this.uploadFileWithRetry(file)
    }, this.uploadFilesConcurrency)
    return pool.start()
  }

  async uploadFileWithRetry(obj) {
    let tryCount = 0;
    while (tryCount < 3) {
      try {
        await this.uploadFile(obj);
        Log('sentry upload success: ', obj.name);
        break;
      } catch (err) {
        if (
          this.suppressErrors ||
          (this.suppressConflictError && err.statusCode === 409)
        ) {
          break;
        }
        console.warn('sentry catch err', err)
        console.warn('sentry upload retry: -->', tryCount++, obj.name);
      }
    }
  }

  uploadFile({ path, name }) {
    if (!path) return false;
    return Promise.race([
      timeout(this.reqTimeout)
      , request(
        this.combineRequestOptions(
          {
            url: `${this.sentryReleaseUrl()}/${this.releaseVersion}/files/`,
            method: 'POST',
            auth: {
              bearer: this.apiKey,
            },
            headers: {},
            formData: {
              file: fs.createReadStream(path),
              name: this.filenameTransform(name),
            },
          },
          this.uploadFileRequestOptions,
        ),
      )]);
  }

  sentryReleaseUrl() {
    return `${this.baseSentryURL}/organizations/${this
      .organizationSlug}/releases`
  }

  deleteFiles(stats) {
    Object.keys(stats.compilation.assets)
      .filter(name => this.deleteRegex.test(name))
      .forEach((name) => {
        const existsAt = fspath.join(stats.compilation.outputOptions.path, name);
        if (existsAt) {
          fs.unlinkSync(existsAt)
        }
      })
  }
}


function timeout(ms) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(reject.bind(undefined, 'timeout'), ms);
    timers.add(timer)
  })
}
