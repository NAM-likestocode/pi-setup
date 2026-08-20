import { getCurrentWindow } from "@tauri-apps/api/window";
import { type FormEvent, type MouseEvent, useState } from "react";
import type { CompanionStatus } from "../lib/commands";

interface StatusPanelProps {
	status: CompanionStatus | null;
	error: string | null;
	onRefresh: () => void;
	onPair: () => void;
	onRePair: () => void;
	onToggle: () => void;
	onDisconnect: (instanceId: string) => void;
	disconnectingInstanceId: string | null;
	onRename: (instanceId: string, name: string) => Promise<void>;
	renamingInstanceId: string | null;
	onDiagnostics: () => void;
}

function beginWindowDrag(event: MouseEvent<HTMLElement>) {
	if (event.button !== 0) return;
	void getCurrentWindow()
		.startDragging()
		.catch((error) => {
			console.error("Could not move the companion window", error);
		});
}

function minimizeWindow(event: MouseEvent<HTMLButtonElement>) {
	event.stopPropagation();
	void getCurrentWindow()
		.minimize()
		.catch((error) => {
			console.error("Could not minimize the companion window", error);
		});
}

export function StatusPanel({
	status,
	error,
	onRefresh,
	onPair,
	onRePair,
	onToggle,
	onDisconnect,
	disconnectingInstanceId,
	onRename,
	renamingInstanceId,
	onDiagnostics,
}: StatusPanelProps) {
	const machineLabel = status?.machineId
		? status.machineId.slice(0, 8)
		: "unknown";
	const [editingInstanceId, setEditingInstanceId] = useState<string | null>(
		null,
	);
	const [draftName, setDraftName] = useState("");

	function beginRename(instanceId: string, title: string) {
		setEditingInstanceId(instanceId);
		setDraftName(title);
	}

	async function submitRename(
		event: FormEvent<HTMLFormElement>,
		instanceId: string,
	) {
		event.preventDefault();
		try {
			await onRename(instanceId, draftName);
			setEditingInstanceId(null);
		} catch {
			// App displays the command error and keeps the draft available.
		}
	}

	return (
		<>
			{/* Native title-bar dragging is intentionally pointer-only. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the OS provides keyboard window movement */}
			<header className="app-header" onMouseDown={beginWindowDrag}>
				<span className="drag-grip" aria-hidden="true">
					••••••
				</span>
				<div className="brand-lockup">
					<span className="brand-mark" aria-hidden="true">
						<img src="./pimo-mark.png" alt="" />
					</span>
					<div>
						<p className="brand-name">Pimo</p>
						<p className="brand-subtitle">Desktop companion</p>
					</div>
				</div>
				<div className="header-actions">
					{status && !error && (
						<div
							className={`status-pill ${status.enabled ? "online" : "paused"}`}
						>
							<span className="status-dot" aria-hidden="true" />
							{status.enabled ? "Online" : "Paused"}
						</div>
					)}
					<button
						type="button"
						className="window-control"
						aria-label="Minimize Pimo Companion"
						title="Minimize"
						onMouseDown={(event) => event.stopPropagation()}
						onClick={minimizeWindow}
					>
						<span aria-hidden="true">−</span>
					</button>
				</div>
			</header>

			{error ? (
				<section className="error-card" role="alert">
					<div className="section-icon danger" aria-hidden="true">
						!
					</div>
					<div className="error-copy">
						<p className="kicker">NEEDS ATTENTION</p>
						<h1>We couldn’t reach Pimo Companion.</h1>
						<p>{error}</p>
						<button
							type="button"
							className="primary-button"
							onClick={onRefresh}
						>
							Try again
						</button>
					</div>
				</section>
			) : !status ? (
				<section className="loading-card" aria-live="polite">
					<span className="loading-orb" aria-hidden="true" />
					<div>
						<p className="kicker">STARTING UP</p>
						<h1>Connecting to this computer…</h1>
						<p className="muted">The local bridge is waking up.</p>
					</div>
				</section>
			) : (
				<>
					<section className="hero-card">
						<div className="hero-copy">
							<p className="kicker">DESKTOP COMPANION</p>
							<h1>
								{status.enabled
									? "Your sessions, close at hand."
									: "Pimo is taking a pause."}
							</h1>
							<p>
								{status.enabled
									? "Connect Pimo on your phone to see and steer interactive Pi sessions across your private network."
									: "Resume Pimo when you want the private mobile connection back."}
							</p>
						</div>
						<div className="hero-action">
							<div className="signal-ring" aria-hidden="true">
								<span>↗</span>
							</div>
							<button type="button" className="primary-button" onClick={onPair}>
								Pair a phone
							</button>
						</div>
					</section>

					<section className="status-summary" aria-label="Companion status">
						<div className="summary-item featured">
							<span className="summary-dot" aria-hidden="true" />
							<span>
								<small>Active sessions</small>
								<strong>{status.instanceCount}</strong>
							</span>
						</div>
						<div className="summary-item">
							<span
								className={`summary-dot ${status.publicPort ? "ready" : "waiting"}`}
								aria-hidden="true"
							/>
							<span>
								<small>Private link</small>
								<strong>{status.publicPort ? "Ready" : "Waiting"}</strong>
							</span>
						</div>
						<div className="summary-item">
							<span
								className={`summary-dot ${status.internalPort ? "ready" : "waiting"}`}
								aria-hidden="true"
							/>
							<span>
								<small>Local bridge</small>
								<strong>{status.internalPort ? "Ready" : "Starting"}</strong>
							</span>
						</div>
					</section>

					<section className="sessions-card">
						<div className="section-heading">
							<div>
								<p className="kicker">LIVE PI</p>
								<h2>Session control</h2>
							</div>
							<span className="session-count">
								{status.instances.length} active
							</span>
						</div>
						{status.instances.length > 0 ? (
							<div className="session-list">
								{status.instances.map((instance) => {
									const title =
										instance.sessionName ||
										instance.projectName ||
										"Pi session";
									const detail = [
										title !== instance.projectName
											? instance.projectName
											: undefined,
										instance.model,
									]
										.filter(Boolean)
										.join(" · ");
									const disconnecting = disconnectingInstanceId === instance.id;
									const renaming = renamingInstanceId === instance.id;
									const editing = editingInstanceId === instance.id;
									const controlsBusy = Boolean(
										disconnectingInstanceId || renamingInstanceId,
									);
									return (
										<div
											className={`session-row ${editing ? "editing" : ""}`}
											key={`${instance.id}-${instance.epoch}`}
											title={instance.cwd}
										>
											<span
												className={`session-state ${instance.state}`}
												aria-hidden="true"
											/>
											{editing ? (
												<form
													className="session-rename-form"
													onSubmit={(event) =>
														void submitRename(event, instance.id)
													}
												>
													<input
														aria-label={`Pimo display name for ${title}`}
														maxLength={80}
														placeholder="Clear to use Pi's name"
														value={draftName}
														onChange={(event) => setDraftName(event.target.value)}
													/>
													<button
														type="submit"
														className="session-save"
														disabled={renaming}
													>
														{renaming ? "Saving…" : "Save"}
													</button>
													<button
														type="button"
														className="session-cancel"
														disabled={renaming}
														onClick={() => setEditingInstanceId(null)}
													>
														Cancel
													</button>
												</form>
											) : (
												<>
													<span className="session-copy">
														<strong>{title}</strong>
														<small>{detail || instance.state}</small>
													</span>
													<span className="session-actions">
														<button
															type="button"
															className="session-rename"
															disabled={controlsBusy}
															onClick={() => beginRename(instance.id, title)}
														>
															Rename
														</button>
														<button
															type="button"
															className="session-disconnect"
															disabled={controlsBusy}
															onClick={() => onDisconnect(instance.id)}
														>
															{disconnecting ? "Disconnecting…" : "Disconnect"}
														</button>
													</span>
												</>
											)}
										</div>
									);
								})}
							</div>
						) : (
							<p className="session-empty">No Pi sessions are connected.</p>
						)}
						<p className="session-note">
							Rename changes the Pimo display name on desktop and mobile. Clear
							the name and save to restore Pi’s original name. Disconnect removes
							remote access only.
						</p>
					</section>

					<section className="controls-card">
						<div className="section-heading">
							<div>
								<p className="kicker">CONTROL ROOM</p>
								<h2>Connection controls</h2>
							</div>
							<span className="machine-chip mono">{machineLabel}</span>
						</div>
						<div className="control-list">
							<button type="button" className="control-row" onClick={onRePair}>
								<span className="control-symbol">⌁</span>
								<span>
									<strong>Replace phone pairing</strong>
									<small>Revoke the current phone and create a fresh QR.</small>
								</span>
								<span className="row-arrow">→</span>
							</button>
							<button type="button" className="control-row" onClick={onToggle}>
								<span className="control-symbol">
									{status.enabled ? "Ⅱ" : "▶"}
								</span>
								<span>
									<strong>
										{status.enabled ? "Pause Pimo" : "Resume Pimo"}
									</strong>
									<small>
										{status.enabled
											? "Stop private access without closing the companion."
											: "Restore the private mobile connection."}
									</small>
								</span>
								<span className="row-arrow">→</span>
							</button>
							<button
								type="button"
								className="control-row"
								onClick={onDiagnostics}
							>
								<span className="control-symbol">⌘</span>
								<span>
									<strong>Copy diagnostics</strong>
									<small>Useful when troubleshooting a connection.</small>
								</span>
								<span className="row-arrow">→</span>
							</button>
						</div>
					</section>
				</>
			)}
		</>
	);
}
