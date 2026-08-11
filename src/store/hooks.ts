import { useDispatch, useSelector, useStore } from 'react-redux';
import type { AppDispatch, AppStore, RootState } from './index';

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

/**
 * The store instance itself, for *non-reactive* reads.
 *
 * The grid reads cell values through `store.getState()` inside its valueGetters
 * rather than through `useSelector`. That is the point of the whole design: a
 * `useSelector` over result data would re-render React on every keystroke, and
 * re-rendering a component that owns 50,000 rows is exactly the cost we're
 * avoiding. React renders the grid once; updates after that are surgical
 * cell refreshes driven by `gridSync`.
 */
export const useAppStore = useStore.withTypes<AppStore>();
