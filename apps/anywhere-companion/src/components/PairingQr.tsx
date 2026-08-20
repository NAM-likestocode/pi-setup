import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

interface PairingQrProps {
	uri?: string;
	onClose: () => void;
}

export function PairingQr({ uri, onClose }: PairingQrProps) {
	const [copied, setCopied] = useState(false);

	async function copyUri() {
		if (!uri) return;
		try {
			await navigator.clipboard.writeText(uri);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1800);
		} catch {
			setCopied(false);
		}
	}

	return (
		<section className="pairing-card">
			<div className="section-heading">
				<div>
					<p className="kicker">ONE-TIME HANDSHAKE</p>
					<h2>Pair a phone</h2>
				</div>
				<button
					type="button"
					className="icon-button"
					aria-label="Close pairing panel"
					onClick={onClose}
				>
					×
				</button>
			</div>
			{uri ? (
				<div className="pairing-layout">
					<div className="qr-shell">
						<QRCodeSVG
							value={uri}
							size={280}
							level="M"
							bgColor="#fffaf1"
							fgColor="#211a13"
							includeMargin
						/>
					</div>
					<div className="pairing-copy">
						<p>
							Open Pimo on your phone and scan this code. It expires after ten
							minutes and can only be used once.
						</p>
						<button
							type="button"
							className="secondary-button"
							onClick={() => void copyUri()}
						>
							{copied ? "Copied" : "Copy pairing code"}
						</button>
						<code className="pairing-uri">{uri}</code>
					</div>
				</div>
			) : (
				<p className="muted">
					Start a connected Pi session, then create a new pairing code.
				</p>
			)}
		</section>
	);
}
