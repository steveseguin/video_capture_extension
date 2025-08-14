// Bridge script to communicate between extension and page context
(function() {
    if (window.vdoBridgeInjected) return;
    window.vdoBridgeInjected = true;
    
    console.log('VDO Bridge initializing...');
    
    // Listen for messages from the extension
    window.addEventListener('vdo-publish-request', async (event) => {
        console.log('Bridge received publish request:', event.detail);
        
        // Call the page context function if available
        if (typeof window.publishVideoToVDO === 'function') {
            const result = await window.publishVideoToVDO(
                event.detail.videoId,
                event.detail.streamId,
                event.detail.roomId,
                event.detail.title
            );
            
            // Send result back
            window.dispatchEvent(new CustomEvent('vdo-publish-response', {
                detail: result
            }));
        } else {
            console.error('publishVideoToVDO not available');
            window.dispatchEvent(new CustomEvent('vdo-publish-response', {
                detail: { success: false, error: 'Publisher function not found' }
            }));
        }
    });
    
    // Listen for stop requests
    window.addEventListener('vdo-stop-request', async (event) => {
        console.log('Bridge received stop request:', event.detail);
        
        if (typeof window.stopVDOPublisher === 'function') {
            const result = await window.stopVDOPublisher(event.detail.streamId);
            
            window.dispatchEvent(new CustomEvent('vdo-stop-response', {
                detail: result
            }));
        } else {
            window.dispatchEvent(new CustomEvent('vdo-stop-response', {
                detail: { success: false, error: 'Stop function not found' }
            }));
        }
    });
    
    console.log('VDO Bridge ready');
})();