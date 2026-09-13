import {DriveCopiesWorkspace} from './drive-copies-workspace';
import {FileUpload,UploadInventory} from './file-upload';
import { ClaimsWorkspace } from './claims-workspace';
import { ArtifactsWorkspace } from './artifacts-workspace';
import { MetricsWorkspace } from './metrics-workspace';
import { useState } from 'react';
import { DocumentationActivities } from './documentation-notes-workspace';
import { InitiativesWorkspace } from './initiatives-workspace';

export function DocumentationWorkspace(props:{admin?:boolean;accessChecking?:boolean;reloadAccess:()=>void}) {
 const [view,setView]=useState(new URLSearchParams(window.location.search).has('drivePicker')?'drive-copies':'activities');const [occupied,setOccupied]=useState(false);
 return <section className="hours-workspace documentation-workspace"><div className="page-intro"><h1>Activity Documentation</h1></div><nav className="hours-actions ui-control-group" aria-label="Documentation views">{['activities','initiatives','metrics','artifacts','drive-copies','uploads','claims','definitions'].map(value=><button key={value} aria-pressed={view===value} disabled={occupied||props.accessChecking} onClick={()=>setView(value)}>{value==='activities'?'Activities':value==='initiatives'?'Initiatives':value==='metrics'?'Metrics':value==='artifacts'?'Artifacts':value==='claims'?'Claims':value==='drive-copies'?'Drive copies':value==='uploads'?'File uploads':'Definitions'}</button>)}</nav>{view==='activities'?<DocumentationActivities {...props} onOccupied={setOccupied}/>:view==='initiatives'?<InitiativesWorkspace accessChecking={props.accessChecking} reloadAccess={props.reloadAccess} onOccupied={setOccupied}/>:view==='metrics'?<MetricsWorkspace accessChecking={props.accessChecking} reloadAccess={props.reloadAccess} onOccupied={setOccupied}/>:view==='drive-copies'?<DriveCopiesWorkspace {...props} onOccupied={setOccupied}/>:view==='uploads'?<><FileUpload {...props} onOccupied={setOccupied}/><UploadInventory {...props}/></>:view==='claims'||view==='definitions'?<ClaimsWorkspace key={view} kind={view} accessChecking={props.accessChecking} reloadAccess={props.reloadAccess} onOccupied={setOccupied}/>:<ArtifactsWorkspace accessChecking={props.accessChecking} reloadAccess={props.reloadAccess} onOccupied={setOccupied}/>}</section>;
}
