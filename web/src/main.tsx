import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from './api';
import App from './App';
import { ToastProvider } from './components/ui';
import { AuthProvider } from './lib/auth';
import '@fontsource-variable/inter';
import '@fontsource/outfit/700.css';
// The HSL Suite kit: shared tokens, frame, sign-in card, app switcher, user menu and theme.
import './hsl-ui/tokens.css';
import './hsl-ui/shell.css';
import './hsl-ui/auth.css';
import './hsl-ui/suite.js';
import './styles.css';

// Light is the default; dark is opt-in from the user menu, the Account page or the command palette.
// Harbor Master's own setting (hsl-theme-v2) moves to the suite's key once. The older hsl-theme value
// predates the light default and is dropped, not migrated.
window.HSLSuite.theme.migrate(['hsl-theme-v2']);
try {
  localStorage.removeItem('hsl-theme');
} catch {
  /* storage unavailable */
}

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
