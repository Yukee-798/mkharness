// Bundle the installed, pinned Penpal runtime with the application. It is never a
// report CDN dependency, and this bridge is omitted from exported HTML.
import penpalSource from '../../../node_modules/penpal/dist/penpal.min.js?raw';
export function reportBridge(token: string) {
  const bootstrap = `(() => {
    const token = ${JSON.stringify(token)};
    let connection, remote, lastError;
    const notify = (name, value) => { if (remote) remote[name](value).catch(()=>{}); };
    addEventListener('message', function initialize(event) {
      if (event.source !== parent || event.data?.kind !== 'report:connect' || event.data.token !== token || !event.ports[0] || connection) return;
      removeEventListener('message', initialize);
      connection = Penpal.connect({ messenger: new Penpal.PortMessenger({port:event.ports[0]}), methods: {
        setDependencyError(message) {
          if (typeof message !== 'string' || message.length > 300) return;
          document.documentElement.dataset.reportDependencyErrorMessage = message;
          const banner = document.querySelector('[data-report-dependency-error]');
          if (banner) banner.textContent = message;
        }
      }, timeout: 10000 });
      connection.promise.then(value => { remote=value; notify('ready', {token}); if(lastError || document.documentElement.dataset.dependencyError) notify('error',{token,message:lastError || 'CDN dependency failed'}); }).catch(()=>{});
    });
    addEventListener('error', event => { lastError=String(event.message || 'report_resource_failed').slice(0,500); notify('error', {token, message:lastError}); });
    addEventListener('unhandledrejection', () => { lastError='report_script_failed'; notify('error', {token,message:lastError}); });
    addEventListener('pagehide', () => connection?.destroy());
  })();`;
  return `<script>${penpalSource.replace(/<\/script/gi, '<\\/script')}\n${bootstrap}</script>`;
}
