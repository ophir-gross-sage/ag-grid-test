import { configureStore } from '@reduxjs/toolkit';
import { setAutoFreeze } from 'immer';
import { aspectsReducer } from './aspectsSlice';
import { mainEntitiesReducer } from './mainEntitiesSlice';
import { resultsReducer } from './resultsSlice';
import { extraDataReducer } from './extraDataSlice';
import { gridSyncMiddleware } from './gridSync';

/**
 * Immer deep-freezes produced state in development. On slices holding 50,000-
 * element arrays that is an O(n) walk attached to state production, for a
 * guarantee the columnar slices deliberately don't rely on. Off.
 */
setAutoFreeze(false);

export const store = configureStore({
  reducer: {
    aspects: aspectsReducer,
    mainEntities: mainEntitiesReducer,
    results: resultsReducer,
    extraData: extraDataReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      /**
       * Both default dev checks walk the entire state tree on every single
       * action. At 50,000 rows that is tens of milliseconds per dispatch — it
       * would blow the frame budget on its own, and it would flag the typed
       * arrays as "non-serialisable" on every write. The payloads we dispatch
       * are plain numbers and strings, so there is nothing here for them to find.
       */
      serializableCheck: false,
      immutableCheck: false,
    }).concat(gridSyncMiddleware),

  /**
   * DevTools serialises a snapshot of state per action. A 50,000-row snapshot
   * per keystroke is the single most expensive thing that could happen in this
   * app, and it would silently destroy the frame budget the whole design exists
   * to protect. Flip to `true` only for a deliberate debugging session.
   */
  devTools: false,
});

export type AppStore = typeof store;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
