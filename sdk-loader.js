// This file loads in the page context
(function() {
    if (window.vdoSdkLoaderInitialized) {
        console.log('SDK loader already initialized');
        return;
    }
    window.vdoSdkLoaderInitialized = true;
    
    console.log('SDK loader starting...');

    // Load the actual SDK
    const sdkScript = document.createElement('script');
    sdkScript.src = chrome.runtime.getURL('vdoninja-sdk.js');
    sdkScript.onload = () => {
        console.log('VDO.Ninja SDK loaded successfully');
        
        // Load the publisher functions
        const pubScript = document.createElement('script');
        pubScript.src = chrome.runtime.getURL('publisher-functions.js');
        pubScript.onload = () => {
            console.log('Publisher functions loaded');
            
            // Load the bridge for communication
            const bridgeScript = document.createElement('script');
            bridgeScript.src = chrome.runtime.getURL('bridge.js');
            bridgeScript.onload = () => {
                console.log('Bridge loaded');
                window.vdoFullyLoaded = true;
            };
            document.head.appendChild(bridgeScript);
        };
        document.head.appendChild(pubScript);
    };
    document.head.appendChild(sdkScript);
})();