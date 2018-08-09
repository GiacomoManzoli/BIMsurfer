#version 300 es

precision mediump int;
precision mediump float;

in vec3 vertexPosition;
in vec3 vertexNormal;
in vec4 vertexColor;

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 viewNormalMatrix;

uniform LightData {
	vec3 dir;
	vec3 color;
	vec3 ambientColor;
	float intensity;
} lightData;

out mediump vec4 color;

void main(void) {

    vec3 viewNormal = normalize(viewNormalMatrix * vertexNormal);
    float lambertian = max(dot(-viewNormal, normalize(lightData.dir)), 0.0);

    gl_Position = projectionMatrix * viewMatrix * vec4(vertexPosition, 1);
    color = vec4(lambertian * vertexColor.rgb, vertexColor.a);
}