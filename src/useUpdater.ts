import { useCallback, useEffect, useRef, useState } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { version as packageVersion } from "../package.json";

export function useUpdater() {
  const [currentVersion, setCurrentVersion] = useState(packageVersion);
  const [tauriVersion, setTauriVersion] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const checkInFlight = useRef(false);
  const startupCheckStarted = useRef(false);
  const updateRef = useRef<Update | null>(null);

  const checkForUpdates = useCallback(async () => {
    if (checkInFlight.current || installing) return;
    checkInFlight.current = true;
    setChecking(true);
    setError(null);
    try {
      const update = await check();
      if (updateRef.current && updateRef.current !== update)
        void updateRef.current.close().catch(() => undefined);
      updateRef.current = update;
      setAvailableUpdate(update);
      setChecked(true);
      if (update) setPromptOpen(true);
    } catch (failure) {
      if (updateRef.current) void updateRef.current.close().catch(() => undefined);
      updateRef.current = null;
      setAvailableUpdate(null);
      setPromptOpen(false);
      setError(String(failure));
    } finally {
      checkInFlight.current = false;
      setChecking(false);
    }
  }, [installing]);

  useEffect(() => {
    void getVersion()
      .then(setCurrentVersion)
      .catch(() => undefined);
    void getTauriVersion()
      .then(setTauriVersion)
      .catch(() => undefined);
    if (import.meta.env.DEV || startupCheckStarted.current) return;
    startupCheckStarted.current = true;
    void checkForUpdates();
  }, [checkForUpdates]);

  const installUpdate = async () => {
    if (!availableUpdate || installing || checkInFlight.current) return;
    setInstalling(true);
    setError(null);
    setDownloadedBytes(0);
    setTotalBytes(null);
    try {
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") setTotalBytes(event.data.contentLength ?? null);
        if (event.event === "Progress")
          setDownloadedBytes((value) => value + event.data.chunkLength);
      });
      try {
        await relaunch();
      } catch {
        setPromptOpen(false);
        setInstalling(false);
        setAvailableUpdate(null);
        toast.info("Update installed. Please restart Kodama manually.");
      }
    } catch (failure) {
      setError(String(failure));
      setInstalling(false);
      setPromptOpen(false);
    }
  };

  return {
    currentVersion,
    tauriVersion,
    availableUpdate,
    checking,
    checked,
    installing,
    downloadedBytes,
    totalBytes,
    error,
    promptOpen,
    setPromptOpen,
    checkForUpdates,
    installUpdate,
  };
}
