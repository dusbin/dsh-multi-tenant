/**
 * dsh-multi-tenant — 浏览器半（登录门禁）。
 *
 * 手写 client bundle（与 dsh-voice 同构，无需构建工具链）：
 * `window.__ModuleLoader__.load({ id, factory })`，factory 内的 `require()`
 * 由浏览器模块表解析（react 为平台种子模块）。
 *
 * 功能（M1）：
 *  - 注册 `shell.overlay` 槽位：未登录时全屏登录层（邮箱密码），
 *    系统未初始化时显示 bootstrap 平台管理员向导；已登录渲染 null。
 *  - 认证接口走网关同源 `/api/auth/*`（credentials: include）。
 *  - 登录/引导成功后整页刷新，让 shell 以已认证状态重建连接。
 *
 * 安全说明：本层只是 UX；真正的认证强制在网关（host 半）完成。
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-tenant',
  factory: (require) => {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    // ---------------------------------------------------------------------
    // i18n（M1 内联；M2 接入 ctx.locale）
    // ---------------------------------------------------------------------
    var dict = {
      zh: {
        title: 'DeepSeek Harness',
        subtitle: '多租户工作台',
        username: '用户名 / 邮箱',
        password: '密码',
        login: '登 录',
        loggingIn: '登录中…',
        bootstrapTitle: '初始化系统',
        bootstrapHint: '首次使用：创建平台管理员账号',
        confirm: '创建并进入',
        creating: '创建中…',
        checking: '正在检查登录状态…',
        error_invalid_credentials: '用户名或密码错误',
        error_rate_limited: '尝试次数过多，请稍后再试',
        error_account_disabled: '账号已被禁用',
        error_account_locked: '账号已锁定',
        error_network: '无法连接服务器，请重试',
        error_unknown: '操作失败，请重试',
        error_invalid_input: '输入不合法（用户名 2-64 字符，密码至少 8 位）',
        error_already_initialized: '系统已初始化',
        retry: '重试',
      },
      en: {
        title: 'DeepSeek Harness',
        subtitle: 'Multi-tenant workspace',
        username: 'Username / Email',
        password: 'Password',
        login: 'Sign in',
        loggingIn: 'Signing in…',
        bootstrapTitle: 'Initialize system',
        bootstrapHint: 'First run: create the platform admin account',
        confirm: 'Create & enter',
        creating: 'Creating…',
        checking: 'Checking session…',
        error_invalid_credentials: 'Invalid username or password',
        error_rate_limited: 'Too many attempts, try again later',
        error_account_disabled: 'Account is disabled',
        error_account_locked: 'Account is locked',
        error_network: 'Cannot reach server, retry',
        error_unknown: 'Operation failed, retry',
        error_invalid_input: 'Invalid input (username 2-64 chars, password ≥ 8 chars)',
        error_already_initialized: 'System already initialized',
        retry: 'Retry',
      },
    };

    var lang = (typeof navigator !== 'undefined' && navigator.language && navigator.language.toLowerCase().startsWith('zh')) ? 'zh' : 'en';
    function t(key) {
      return (dict[lang] && dict[lang][key]) || dict.zh[key] || key;
    }

    // ---------------------------------------------------------------------
    // 样式（物化时注入一次）
    // ---------------------------------------------------------------------
    (function injectCss() {
      var style = document.createElement('style');
      style.setAttribute('data-plugin-css', 'dsh-multi-tenant/login');
      style.textContent = [
        '.mt-login-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;',
        'background:var(--dsw-alias-bg-base,#0b0e14);pointer-events:auto;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}',
        '.mt-login-card{width:360px;max-width:calc(100vw - 48px);background:var(--dsw-alias-bg-raised,#141922);',
        'border:1px solid var(--dsw-alias-border,#2a3242);border-radius:14px;padding:32px 28px;box-shadow:0 12px 40px rgba(0,0,0,.35);}',
        '.mt-login-brand{font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary,#e8eaf0);text-align:center;}',
        '.mt-login-sub{font-size:13px;color:var(--dsw-alias-label-secondary,#9aa3b2);text-align:center;margin-top:4px;margin-bottom:24px;}',
        '.mt-login-field{margin-bottom:14px;}',
        '.mt-login-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);margin-bottom:6px;}',
        '.mt-login-input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;outline:none;',
        'background:var(--dsw-alias-bg-input,#0f131b);border:1px solid var(--dsw-alias-border,#2a3242);color:var(--dsw-alias-label-primary,#e8eaf0);font-size:14px;}',
        '.mt-login-input:focus{border-color:#3b82f6;}',
        '.mt-login-error{color:#f87171;font-size:12px;margin-bottom:12px;min-height:16px;}',
        '.mt-login-btn{width:100%;padding:11px 0;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}',
        '.mt-login-btn:hover{background:#1d4ed8;}',
        '.mt-login-btn:disabled{opacity:.6;cursor:default;}',
        '.mt-login-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);text-align:center;margin-top:16px;}',
      ].join('');
      document.head.appendChild(style);
    })();

    // ---------------------------------------------------------------------
    // 登录门禁组件
    // ---------------------------------------------------------------------
    var e = React.createElement;

    function api(path, options) {
      return fetch(path, Object.assign({ credentials: 'include' }, options || {}));
    }

    function LoginOverlay() {
      var state = React.useState('checking'); // checking | login | bootstrap | authed
      var status = state[0];
      var setStatus = state[1];
      var usernameState = React.useState('');
      var username = usernameState[0];
      var setUsername = usernameState[1];
      var passwordState = React.useState('');
      var password = passwordState[0];
      var setPassword = passwordState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      React.useEffect(function () {
        var cancelled = false;
        api('/api/auth/me').then(function (res) {
          return res.json().catch(function () { return {}; });
        }).then(function (data) {
          if (cancelled) return;
          if (data && data.ok && data.user) setStatus('authed');
          else if (data && data.bootstrapRequired) setStatus('bootstrap');
          else setStatus('login');
        }).catch(function () {
          if (!cancelled) { setStatus('login'); setError('error_network'); }
        });
        return function () { cancelled = true; };
      }, []);

      if (status === 'authed') return null;

      function submit(endpoint) {
        setBusy(true);
        setError(null);
        api(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: username, password: password }),
        }).then(function (res) {
          return res.json().catch(function () { return {}; });
        }).then(function (data) {
          if (data && data.ok) { window.location.reload(); return; }
          var code = data && data.error ? data.error.code : 'unknown';
          setError('error_' + code);
          setBusy(false);
        }).catch(function () {
          setError('error_network');
          setBusy(false);
        });
      }

      var isBootstrap = status === 'bootstrap';
      var isChecking = status === 'checking';

      return e(
        'div', { className: 'mt-login-overlay' },
        e(
          'div', { className: 'mt-login-card' },
          e('div', { className: 'mt-login-brand' }, t('title')),
          e('div', { className: 'mt-login-sub' }, isBootstrap ? t('bootstrapHint') : t('subtitle')),
          isChecking
            ? e('div', { className: 'mt-login-hint' }, t('checking'))
            : e(
              React.Fragment,
              null,
              e(
                'div', { className: 'mt-login-field' },
                e('label', { className: 'mt-login-label' }, t('username')),
                e('input', {
                  className: 'mt-login-input',
                  value: username,
                  disabled: busy,
                  autoComplete: 'username',
                  onChange: function (ev) { setUsername(ev.target.value); },
                }),
              ),
              e(
                'div', { className: 'mt-login-field' },
                e('label', { className: 'mt-login-label' }, t('password')),
                e('input', {
                  className: 'mt-login-input',
                  type: 'password',
                  value: password,
                  disabled: busy,
                  autoComplete: isBootstrap ? 'new-password' : 'current-password',
                  onChange: function (ev) { setPassword(ev.target.value); },
                  onKeyDown: function (ev) {
                    if (ev.key === 'Enter' && !busy) submit(isBootstrap ? '/api/auth/bootstrap' : '/api/auth/login');
                  },
                }),
              ),
              e('div', { className: 'mt-login-error' }, error ? t(error) : ''),
              e(
                'button',
                {
                  className: 'mt-login-btn',
                  disabled: busy || !username || !password,
                  onClick: function () { submit(isBootstrap ? '/api/auth/bootstrap' : '/api/auth/login'); },
                },
                busy ? (isBootstrap ? t('creating') : t('loggingIn')) : (isBootstrap ? t('confirm') : t('login')),
              ),
              isBootstrap ? null : e('div', { className: 'mt-login-hint' }, t('checking')),
            ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 浏览器插件体
    // ---------------------------------------------------------------------
    exports.name = 'dsh-multi-tenant';
    exports.inject = ['slots', 'locale'];

    exports.apply = function apply(pluginCtx, config) {
      var ctx = pluginCtx;
      try {
        // 注册登录门禁到全屏浮层槽位（未登录时覆盖整个应用）
        ctx.slots.inject('shell.overlay', function () {
          var dispose = ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-multi-tenant-login', order: -1000 },
            LoginOverlay,
          );
          return function () { dispose(); };
        });

        // 注册 i18n 命名空间（M2 控制台复用）
        try {
          ctx.locale.register('multi-tenant', {
            zh: dict.zh,
            en: dict.en,
          });
        } catch (_e) {
          /* locale 服务不可用时静默降级（内联 dict 仍可用） */
        }

        if (typeof console !== 'undefined') {
          console.log('[dsh-multi-tenant] client activated (login gate on shell.overlay)');
        }
      } catch (error) {
        if (typeof console !== 'undefined') console.error('[dsh-multi-tenant] activation failed:', error);
        throw error;
      }
    };

    return module.exports;
  },
});
