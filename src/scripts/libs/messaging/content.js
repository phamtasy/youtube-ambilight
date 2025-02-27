import { wrapErrorHandler } from '../generic';
import { extensionId, isSameWindowMessage } from './utils';

class ContentScript {
  globalListener;
  listeners = [];

  addMessageListener = (type, handler) => {
    // console.log('content addMessageListener', type)
    if (!this.globalListener) {
      // console.log('content addMessageListenerGlobal')
      this.globalListener = wrapErrorHandler(
        function contentScriptMessageListenerGlobal(event) {
          if (!event.detail || typeof event.detail !== 'string') return;
          const detail = JSON.parse(event.detail);
          // console.log('received in injectedScript', event.detail?.type, event.detail?.contentScript, event, '|', event.detail?.injectedScript);
          if (
            !isSameWindowMessage ||
            detail?.contentScript !== extensionId ||
            !detail?.type
          )
            return;

          for (const listener of this.listeners) {
            listener(detail);
          }
        }.bind(this),
        true
      );
      document.addEventListener('ytal-message', this.globalListener);
      // window.addEventListener('message', this.globalListener, true);
    }

    const listener = wrapErrorHandler(
      function contentScriptMessageListener(detail) {
        // console.log('content message?', type, event.detail?.type)
        if (detail.type !== type) return;

        // console.log('content message!', type)
        handler(detail?.message);
      }.bind(this),
      true
    );

    this.listeners.push(listener);
    return listener;
  };

  removeMessageListener = (listener) => {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      // console.log('content removeMessageListener', index, listener)
      this.listeners.splice(index, 1);
    }

    if (this.globalListener && this.listeners.length === 0) {
      // console.log('content removeMessageListenerGlobal', this.globalListener)
      window.removeEventListener('message', this.globalListener, true);
      this.globalListener = undefined;
    }
  };

  postMessage = (type, message) => {
    const event = new CustomEvent('ytal-message', {
      detail: JSON.stringify({
        type,
        message,
        injectedScript: extensionId,
      }),
    });
    // console.log('dispatched from injectedScript', type, extensionId);
    return document.dispatchEvent(event);
  };
}
export const contentScript = new ContentScript();
