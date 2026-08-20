import { useConnection } from "../src/state/connection";
import InstanceScreen from "./instance/[instanceId]";

export default function SessionRoute() {
	const { selectedInstanceId } = useConnection();
	return <InstanceScreen key={selectedInstanceId ?? "no-session"} />;
}
