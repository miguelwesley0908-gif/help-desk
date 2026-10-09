const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function appContext() {
  const root = { innerHTML: '' };
  const context = vm.createContext({
    window: { addEventListener() {} },
    document: { getElementById: () => root },
    location: { search: '', hash: '#/login' },
    URLSearchParams,
    Intl,
    Date,
    console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), context);
  return context;
}

test('converts Brasília booking times to UTC consistently', () => {
  const app = appContext();
  assert.equal(vm.runInContext('bookingLocalToIso("2026-10-09", "08:30")', app), '2026-10-09T11:30:00.000Z');
  assert.equal(vm.runInContext('bookingDateTime("2026-10-09T11:30:00.000Z")', app), '09/10/2026 08:30');
});

test('available slots exclude overlapping meetings and still allow adjacent meetings', () => {
  const app = appContext();
  vm.runInContext(`
    state.busy = [{room_id: 'sala-1', starts_at: '2099-10-09T12:00:00Z', ends_at: '2099-10-09T13:00:00Z'}];
  `, app);
  const starts = vm.runInContext('availableStarts({id:"sala-1"}, "2099-10-09", 60)', app);
  assert.equal(starts.includes('08:00'), true);
  assert.equal(starts.includes('08:30'), false);
  assert.equal(starts.includes('09:00'), false);
  assert.equal(starts.includes('10:00'), true);
});

test('collaborator view contains only own booking details; admin sees client totals', () => {
  const app = appContext();
  vm.runInContext(`
    state.reservationsReady = true;
    state.user = {id:'a', name:'Ana', role:'colaborador', officeId:'o'};
    state.offices = [{id:'o', name:'Escritório', city:'Recife'}];
    state.users = [{id:'a', name:'Ana', role:'colaborador', officeId:'o'}, {id:'b', name:'Bia', role:'colaborador', officeId:'o'}];
    state.rooms = [{id:'sala-1', name:'Sala 1', officeId:'o', capacity:4, active:true}];
    state.bookings = [
      {id:'1',roomId:'sala-1',organizerId:'a',clientName:'Cliente Ana',subject:'Consulta',startsAt:'2099-10-09T11:00:00Z',endsAt:'2099-10-09T12:00:00Z',canceledAt:null},
      {id:'2',roomId:'sala-1',organizerId:'b',clientName:'Cliente Bia',subject:'Sigiloso',startsAt:'2099-10-09T12:00:00Z',endsAt:'2099-10-09T13:00:00Z',canceledAt:null}
    ];
    reservationOfficeId = 'o';
    reservationDate = '2099-10-09';
    state.busy = [];
  `, app);
  const collaborator = vm.runInContext('renderReservations(state.user)', app);
  assert.match(collaborator, /Cliente Ana/);
  assert.doesNotMatch(collaborator, /Cliente Bia|Sigiloso/);
  const admin = vm.runInContext('renderReservations({...state.user, role:"admin"})', app);
  assert.match(admin, /Cliente Bia/);
  assert.match(admin, /Reuniões por advogado e cliente/);
});
