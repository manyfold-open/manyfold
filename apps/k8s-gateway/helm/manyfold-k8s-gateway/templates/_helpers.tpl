{{/* Chart name */}}
{{- define "mkg.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified name — used for every resource */}}
{{- define "mkg.fullname" -}}
{{- if contains (include "mkg.name" .) .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "mkg.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Common labels */}}
{{- define "mkg.labels" -}}
app.kubernetes.io/name: {{ include "mkg.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: manyfold
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels (stable subset) */}}
{{- define "mkg.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mkg.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Name of the Secret carrying MF_K8S_GATEWAY_TOKEN */}}
{{- define "mkg.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-token" (include "mkg.fullname" .) -}}
{{- end -}}
{{- end -}}
