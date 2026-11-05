import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { ContentRecovery } from './contentRecovery';
import {
  APP_URL,
  isAppURL,
  isPageHttpError,
  navigationDecision
} from './navigationPolicy';

const accent = '#861535';

export default function App() {
  const [source, setSource] = useState({ uri: APP_URL });
  const [failure, setFailure] = useState<string | null>(null);
  const requestedPage = useRef(APP_URL);
  const recovery = useRef(new ContentRecovery());
  const webView = useRef<WebView<object>>(null);

  const recover = useCallback((action: ReturnType<ContentRecovery['resume']>) => {
    if (action === 'restore') webView.current?.reload();
    if (action === 'offer-retry')
      setFailure('The page closed again. Tap below to reopen it.');
  }, []);

  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') recover(recovery.current.resume(Date.now()));
    });
    return () => listener.remove();
  }, [recover]);

  function retry() {
    setSource({ uri: requestedPage.current });
    setFailure(null);
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        {failure === null ? (
          <WebView<object>
            testID="scottygo-web"
            ref={webView}
            source={source}
            // Route every scheme through our policy. Otherwise the WebView
            // opens out-of-whitelist URLs directly in an external app.
            originWhitelist={['*']}
            onShouldStartLoadWithRequest={(request) => {
              const decision = navigationDecision(request);
              if (decision === 'openExternal') {
                void Linking.openURL(request.url).catch(() =>
                  Alert.alert('Couldn’t open this link', 'Please try again.')
                );
              } else if (
                decision === 'allow' &&
                request.isTopFrame &&
                isAppURL(request.url)
              ) {
                requestedPage.current = request.url;
              }
              // Keeping onOpenWindow unset preserves the iOS tap type for
              // target="_blank". WebKit opens trusted new windows in this view.
              return decision === 'allow';
            }}
            onLoadStart={({ nativeEvent }) => {
              if (isAppURL(nativeEvent.url))
                requestedPage.current = nativeEvent.url;
            }}
            onError={({ nativeEvent }) => {
              if (
                nativeEvent.domain === 'NSURLErrorDomain' &&
                nativeEvent.code === -999
              )
                return;
              setFailure('Check your internet connection and try again.');
            }}
            onHttpError={({ nativeEvent }) => {
              if (
                isPageHttpError(
                  nativeEvent.url,
                  nativeEvent.statusCode,
                  requestedPage.current
                )
              ) {
                setFailure(
                  `The server returned HTTP ${nativeEvent.statusCode}. Please try again.`
                );
              }
            }}
            onNavigationStateChange={({ url }) => {
              if (isAppURL(url)) requestedPage.current = url;
            }}
            onContentProcessDidTerminate={() =>
              recover(recovery.current.terminated(AppState.currentState === 'active', Date.now()))
            }
            allowsBackForwardNavigationGestures
            javaScriptCanOpenWindowsAutomatically={false}
            incognito={false}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loading}>
                <ActivityIndicator
                  size="large"
                  color={accent}
                  accessibilityLabel="Opening ScottyGo"
                />
              </View>
            )}
          />
        ) : (
          <View style={styles.error}>
            <Text accessibilityRole="header" style={styles.title}>
              Couldn’t open ScottyGo
            </Text>
            <Text style={styles.message}>{failure}</Text>
            <Pressable
              testID="scottygo-retry"
              accessibilityRole="button"
              onPress={retry}
              style={styles.button}
            >
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  loading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff'
  },
  error: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    padding: 24
  },
  title: { color: '#172331', fontWeight: '600', fontSize: 22 },
  message: { color: '#495564', fontSize: 16, textAlign: 'center' },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 24,
    borderRadius: 10,
    backgroundColor: accent
  },
  buttonText: { fontWeight: '600', fontSize: 16, color: '#fff' }
});
