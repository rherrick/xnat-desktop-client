const fs = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');
const getSize = require('get-folder-size');
const axios = require('axios');
require('promise.prototype.finally').shim();
const auth = require('../services/auth');
const api = require('../services/api');
const settings = require('electron-settings');
const ipc = require('electron').ipcRenderer;
const swal = require('sweetalert');
const archiver = require('archiver');
const mime = require('mime-types');

const remote = require('electron').remote;
const mizer = require('../mizer');

const NProgress = require('nprogress');
NProgress.configure({ 
    trickle: false,
    easing: 'ease',
    speed: 1,
    minimum: 0.03
});

let csrfToken = '';
let xnat_server, user_auth, session_map, selected_session_id, defined_project_exp_labels, resseting_functions;
let global_date_required, date_required, selected_session_data;

let anon_variables = {};

async function _init_variables() {
    console.log(':::::::::::::: >>> UPLOAD _init_variables');
    
    xnat_server = settings.get('xnat_server');

    user_auth = auth.get_user_auth();

    session_map = new Map();
    selected_session_id = null;
    

    defined_project_exp_labels = [];
    


    // RESETTING TABS
    resseting_functions = new Map();

    // browse files
    resseting_functions.set(1, function(){
        console.log('resseting values in tab 1');
        
        session_map.clear();
        selected_session_id = null;
        $('#upload_folder, #file_upload_folder').val('');

        $('#upload_folder').closest('.tab-pane').find('.js_next').addClass('disabled');

        $('#dicom_parse_progress').hide().attr({
            value: 0,
            max: 100
        });

    });

    // date selection
    resseting_functions.set(2, function(){
        console.log('resseting values in tab 2')

        $('#upload_session_date').val('');

        if (date_required != undefined) {
            $('#upload_session_date').prop('required', date_required);
            
        
            let next_button = $('#upload_session_date').closest('.tab-pane').find('.js_next');
            if (date_required) {
                next_button.addClass('disabled'); 
            } else {
                next_button.removeClass('disabled');     
            }
        }

    });

    // Review and Verify
    resseting_functions.set(3, function(){
        console.log('resseting values in tab 3');


        $('#nav-verify').find('.js_next').addClass('disabled');
    });

    // Summary
    resseting_functions.set(4, function(){
        summary_clear();
        console.log('resseting values in tab 4')
    });

    resetSubsequentTabs();
    _UI();
}

function _UI() {
    let server_name = xnat_server.split('//')[1];
    $('#server_name_tlbr').text(`[${server_name}]`);
}

function destroyBootstrapTable($tbl) {
    if ($.isPlainObject($tbl.bootstrapTable('getOptions'))) { // bootstrap table already initialized
        $tbl.bootstrapTable('destroy');
    }
}

function _init_img_sessions_table(table_rows) {
    let $img_session_tbl = $('#image_session');

    destroyBootstrapTable($img_session_tbl);

    $img_session_tbl.bootstrapTable({
        height: table_rows.length > 6 ? 300 : 0,
        columns: [
            {
                field: 'select',
                title: 'Upload',
                checkbox: true
            },
            {
                field: 'series_number',
                title: 'Series Number',
                sortable: true,
                align: 'right',
                class: 'right-aligned'
            },
            {
                field: 'description',
                title: 'Series Description',
                sortable: true
            }, 
            {
                field: 'count',
                title: 'File Count',
                sortable: true,
                align: 'right',
                class: 'right-aligned'
            }, 
            {
                field: 'size',
                title: 'Size (bytes)',
                sortable: true,
                align: 'right',
                class: 'right-aligned',
                formatter: function(value, row, index, field) {
                    return `${(value / 1024 / 1024).toFixed(2)} MB`;
                }
            }, 
            {
                field: 'series_id',
                title: 'Series ID',
                visible: false
            }
        ],
        data: table_rows
    });

    $img_session_tbl.bootstrapTable('resetView');
}

function _init_session_selection_table(tbl_data) {
    let $found_sessions_tbl = $('#found_sessions');

    destroyBootstrapTable($found_sessions_tbl);

    $found_sessions_tbl.bootstrapTable({
        height: tbl_data.length > 5 ? 250 : 0,
        columns: [
            {
                field: 'id',
                title: 'StudyInstanceUID',
                visible: false
            },
            {
                field: 'label',
                title: 'StudyID/UID',
                sortable: true,
                class: 'break-all'
            },
            {
                field: 'root_path',
                title: 'Root Path',
                sortable: true,
                class: 'break-all'
            },
            {
                field: 'scan_count',
                title: 'Scans',
                sortable: true,
                class: 'right-aligned'
            },
            {
                field: 'action',
                title: 'Actions',
                class: 'action',
                formatter: function(value, row, index, field) {
                    return `
                    <button data-session_id="${row.id}" type="button" 
                        class="btn btn-primary btn-sm" 
                        style="margin: 2px 0;">Select</button>
                    
                    `;
                }
            }
            
        ],
        data: tbl_data
    });

    $found_sessions_tbl.bootstrapTable('resetView');
}





if (!settings.has('user_auth') || !settings.has('xnat_server')) {
    ipc.send('redirect', 'login.html');
    return;
}


$(document).on('page:load', '#upload-section', async function(e){
    console.log('Upload page:load triggered');
    
    _init_variables();

    csrfToken = await auth.get_csrf_token(xnat_server, user_auth);
    console.log(csrfToken);

    if (csrfToken === false) {
        // An error occured while fetching CSRF token
    }

    global_allow_create_subject().then(handle_create_subject_response).catch(handle_error);
    global_require_date().then(handle_global_require_date).catch(handle_error);
    


    promise_projects()
        .then(function(resp) {
            let totalRecords = resp.data.ResultSet.Result.length;

            let projects = (totalRecords === 1) ? [resp.data.ResultSet.Result[0]] : resp.data.ResultSet.Result;
            //let projects = resp.data.ResultSet.Result;

            console.log(projects)

            $('#upload-project').html('')

            if (projects.length) {
                for (let i = 0, len = projects.length; i < len; i++) {
                    console.log('---', projects[i].id)
                    $('#upload-project').append(`
                        <li><a href="javascript:void(0)" data-project_id="${projects[i].id}">${projects[i].secondary_id} <span class="project_id">ID: ${projects[i].id}</span></a></li>
                    `)
                }
            } else {
                no_upload_privileges_warning()
            }

        })
        .catch(function(err) {
            console.log(err.message);
        })
    

    $('#upload_session_date')
        .attr('min', '1990-01-01')
        .attr('max', new Date().toISOString().split('T')[0])

        
});

$(document).on('click', '#upload-section a[data-project_id]', function(e){
    resetSubsequentTabs();
    
    $('.tab-pane.active .js_next').addClass('disabled');
    
    $('#subject-session').html('');
    if ($('#upload-project a.selected').length === 0) {
        $('.project-subjects-holder').show();
    }

    $(this).closest('ul').find('a').removeClass('selected');
    $(this).addClass('selected');

    // set Review data
    $('#var_project').val(get_form_value('project_id', 'project_id'));
    

    let project_id = $(this).data('project_id');

    mizer.get_mizer_scripts(xnat_server, user_auth, project_id).then(scripts => {
        if (scripts.length === 0) {
            swal({
                title: `Warning: No anonymization scripts found!`,
                text: `Anonymization scripts are not set for this site or this project. Do you want to continue?`,
                icon: "warning",
                buttons: ['Choose a different project', 'Continue'],
                dangerMode: true
            })
            .then((proceed) => {
                console.log(proceed);
                
                if (proceed) {
                    
                } else {
                    $('#subject-session').html('');
                    $('.project-subjects-holder').hide();

                    $('#upload-project a.selected').removeClass('selected');
                }
            });
        }

        let contexts = mizer.getScriptContexts(scripts);

        anon_variables = mizer.getReferencedVariables(contexts);
    }).catch(function(error) {
        console.log("Failed!", error);
    });

    promise_subjects(project_id)
        .then(res => {
            let subjects = res.data.ResultSet.Result;
            console.log(subjects.length);
            console.log(res.data.ResultSet.Result[0]);

            subjects.forEach(append_subject_row)

        })
        .catch(handle_error);

    project_allow_create_subject(project_id).then(handle_create_subject_response).catch(handle_error);
    project_require_date(project_id).then(handle_require_date).catch(handle_error);


    promise_project_experiments(project_id)
        .then(res => {
            console.log('----------------promise_project_experiments------------------------');
            console.log(res.data.ResultSet.totalRecords, res.data.ResultSet.Result)
            if (res.data.ResultSet.totalRecords) {
                defined_project_exp_labels = res.data.ResultSet.Result.map(function(item){
                    return item.label;
                });
                console.log(defined_project_exp_labels);
            }
            console.log('-----------------------------------------------------------');
        })
        .catch(handle_error);
});

$(document).on('click', 'a[data-subject_id]', function(e){
    resetSubsequentTabs();

    $(this).closest('ul').find('a').removeClass('selected');
    $(this).addClass('selected')

    // set Review data
    $('#var_subject').val(get_form_value('subject_id', 'subject_label'));
    
    $('.tab-pane.active .js_next').removeClass('disabled');
    
});

$(document).on('click', '.js_next:not(.disabled)', function() {
    let active_tab_index = $('.nav-item').index($('.nav-item.active'));
    if ($('.nav-item').eq(active_tab_index + 1).hasClass('hidden')) {
        active_tab_index++;
    }
    $('.nav-item').eq(active_tab_index + 1).removeClass('disabled').trigger('click');
    setTimeout(function() {
        //swal('Disabling NEXT button');
        $('.tab-pane.active .js_next').addClass('disabled');
    }, 100)
});

$(document).on('click', '.js_prev', function() {
    let active_tab_index = $('.nav-item').index($('.nav-item.active'));

    if ($('.nav-item').eq(active_tab_index - 1).hasClass('hidden')) {
        active_tab_index--;
    }

    $('.nav-item').eq(active_tab_index - 1).trigger('click');
    
    setTimeout(function() {
        $('.tab-pane.active .js_next').removeClass('disabled');
    }, 300);

});

$(document).on('change', '#file_upload_folder', function(e) {
    let _files = [];
    resetSubsequentTabs();
    
    console.log(this.files.length);

    if (this.files.length) {
        $('#upload_folder').val(this.files[0].path);

        let pth = this.files[0].path;


        getSizeAsPromised(pth)
            .then(function(response){
                console.log(response);

                if (response > 1000) {
                    swal({
                        title: `Are you sure?`,
                        text: `This folder is ${response} MB in size! Continue?`,
                        icon: "warning",
                        buttons: ['Cancel', 'Continue'],
                        dangerMode: true
                    })
                    .then((proceed) => {
                        if (proceed) {
                            _files = walkSync(pth);
                            console.log(_files);

                            $('#file_upload_folder').val('');
                            dicomParse(_files, pth);
                        } else {
                            $('#upload_folder, #file_upload_folder').val('');
                        }
                    });
                } else {
                    _files = walkSync(pth);
                    console.log(_files);

                    setTimeout(function() {
                        $('#file_upload_folder').val('');
                        dicomParse(_files, pth)
                    }, 0)
                }
                
            })
            .catch(function(err) {
                $('#upload_folder, #file_upload_folder').val('');
                
                swal({
                    title: `Error`,
                    text: `You can't select this folder.\n${err.message}`,
                    icon: "error",
                    dangerMode: true
                })
            });
        
    }
});

$(document).on('input', '#upload_session_date', function(e) {
    resetSubsequentTabs();

    if (this.validity.valid) {
        console.log('Valid')
        console.log(session_map, selected_session_id, session_map.get(selected_session_id), session_map.get(selected_session_id).date);
        if (date_required) {
            if ($('#upload_session_date').val().split("-").join('') === session_map.get(selected_session_id).date) {
                $('.tab-pane.active .js_next').removeClass('disabled');
            } else {
                swal({
                    title: `Error`,
                    text: 'Entered session date doesn\'t match with date from session!',
                    icon: "error",
                    dangerMode: true
                })
                $('.tab-pane.active .js_next').addClass('disabled');
            }
        } else {
            $('.tab-pane.active .js_next').removeClass('disabled');
        }
        
        
    } else {
        console.log('INVALID')
        $('.tab-pane.active .js_next').addClass('disabled');
    }
});

$(document).on('click', '.js_upload', function() {
    let selected = $('#image_session').bootstrapTable('getSelections');

    let $required_inputs = $('#anon_variables').find(':input[required]');
    let required_input_error = false;

    $required_inputs.each(function(){
        if ($(this).val().trim() === '') {
            $(this).addClass('is-invalid');
            required_input_error = true;
        }
    })
    
    
    if (selected.length && !required_input_error) {
        let selected_series = selected.map(function(item){
            return item.series_id;
        });
        
        let expt_label_val = $('#experiment_label').val();

        let url_data = {
            expt_label: expt_label_val ? expt_label_val : get_default_expt_label(),
            project_id: $('a[data-project_id].selected').data('project_id'),
            subject_id: $('a[data-subject_id].selected').data('subject_id')
        };

        let my_anon_variables = {};

        console.log('++++++++++++++', anon_variables);
        

        if (anon_variables.hasOwnProperty('session')) {
            my_anon_variables['session'] = url_data.expt_label;
        }

        $('#anon_variables').find(':input').each(function(){
            let $field = $(this);
            my_anon_variables[$field.attr('name')] = $field.val();
        });

        //doUpload(url_data, selected_session_id, selected_series);
        storeUpload(url_data, selected_session_id, selected_series, my_anon_variables);

    } else {
        swal({
            title: `Form Error`,
            text: `Please select at least one scan series and enter all variable value(s)`,
            icon: "warning",
            dangerMode: true
        })
    }
    

});
$(document).on('input', '#anon_variables :input[required]', function(e){
    let $input = $(this);
    $input.on('input', function(){
        $input.removeClass('is-invalid');
    });
});


$(document).on('show.bs.modal', '#new-subject', function(e) {
    console.log(e)

    let project_id = $('#upload-project a.selected').data('project_id');

    if (!project_id) {
        swal({
            text: 'You must select a project first!',
            icon: "warning",
            dangerMode: true
        })
        .then(value => {
            $('#new-subject').modal('hide');                
        });

    } else {
        $('#new_subject_project_id').html(project_id)
        $('#form_new_subject input[name=project_id]').val(project_id)
        $('#form_new_subject input[name=subject_label]').val('')
        $('#form_new_subject input[name=group]').val('')

        setTimeout(function(){
            $('#form_new_subject input[name=subject_label]').focus()
        }, 500);
    }

});

$(document).on('submit', '#form_new_subject', function(e) {
    e.preventDefault();
    let $form = $(e.target);

    if ($form.data('processing') !== true) {
        $form.data('processing', true);

        let modal_id = '#' + $(this).closest('.modal').attr('id');
        Helper.blockModal(modal_id);
    
        
    
        let project_id, subject_label, group;
    
        project_id = $('#form_new_subject input[name=project_id]').val();
        subject_label = $.trim($('#form_new_subject input[name=subject_label]').val());
        subject_label = subject_label.replace(/\s+/g, '_');

        group = $.trim($('#form_new_subject input[name=group]').val());

        promise_create_project_subject(project_id, subject_label, group)
            .then(res => {
                console.log(res);
    
                append_subject_row({
                    ID: res.data,
                    URI: '/data/subjects/' + res.data,
                    insert_date: '',
                    label: subject_label,
                    group: group
                });
    
                $('#subject-session li:last-child a').trigger('click');
    
                $('#new-subject').modal('hide');
    
            })
            .catch(handle_error)
            .finally(() => {
                Helper.unblockModal(modal_id);
                $form.data('processing', false);
            });
    }
    
    
});

$(document).on('click', '.js_cancel_session_selection', function(){
    resetSubsequentTabs();
    //resetTabsAfter($('#upload-section #nav-tab .nav-link.active').index() - 1)
    resseting_functions.get(1)();
});

$(document).on('hidden.bs.modal', '#session-selection', function(e) {
    console.log(`**** selected_session_id: ${selected_session_id} *****`);
    if (selected_session_id) {
        $('.tab-pane.active .js_next').trigger('click');
    }
});

function select_session_id(new_session_id) {
    selected_session_id = new_session_id;

    
    console.log('******************************************');
    console.log('anon_variables', anon_variables);
    console.log('******************************************');

    $('#additional-upload-fields').html('');
    Object.keys(anon_variables).forEach(key => {
        let key_cap = Helper.capitalizeFirstLetter(key);
        let field_type = (key == 'subject' || key == 'project') ? 'hidden' : 'text';

        let field_text, field_value;
        if (key == 'subject') {
            field_text = get_form_value('subject_id', 'subject_label');
            field_value = field_text;
        } else if (key == 'project') {
            field_text = get_form_value('project_id', 'project_id');
            field_value = field_text;
        } else {
            field_text = '';
            field_value = anon_variables[key];
        }

        if (key != 'project' && key != 'subject' && key != 'session') {
            $('#additional-upload-fields').append(`
            <div class="form-group row">
                <label for="var_${key}" class="col-sm-2 col-form-label"><b>${key_cap}</b>:</label>
                <div class="input-group col-sm-10">
                    <input class="form-control" type="${field_type}" name="${key}" id="var_${key}" value="${field_value}" required>
                    ${field_text}
                </div>
            </div>
            `);
            console.log('$$$$ ' + key + ' => ' + anon_variables[key]);
        }

        
    });

    let session_id = selected_session_id,
        selected_session = session_map.get(session_id),
        total_files = 0,
        total_size = 0,
        table_rows = [];

    selected_session.scans.forEach(function(scan, key) {
        let scan_size = scan.reduce(function(prevVal, elem) {
            return prevVal + elem.filesize;
        }, 0);
        total_size += scan_size;
        total_files += scan.length;
        
        // use scan description from the last one (or any other from the batch)
        let scans_description = scan[0].seriesDescription;
        let series_number = scan[0].seriesNumber
        console.log(scan);
        
        table_rows.push({
            select: true,
            series_number: series_number,
            series_id: key,
            description: scans_description,
            count: scan.length,
            size: scan_size
        })
        
    });

    console.log('-----------------------------------------------------------');
    console.log(table_rows);
    console.log('-----------------------------------------------------------');

    _init_img_sessions_table(table_rows);

    console.log(selected_session.studyDescription);
    console.log(selected_session.modality);
    console.log(selected_session.studyInstanceUid);

    let expt_label = get_default_expt_label();
    
    $('#experiment_label').val(expt_label);

    let studyDate = selected_session.date ? 
        selected_session.date.substr(0, 4) + '-' +
        selected_session.date.substr(4, 2) + '-' +
        selected_session.date.substr(6, 2) + ' ' + 
        
        (selected_session.time ?
            selected_session.time.substr(0, 2) + ':' +
            selected_session.time.substr(2, 2) + ':' +
            selected_session.time.substr(4, 2) :
            ''
        ) : 
        'N/A';
    
    $('#session_info').html('')
        .append(`Study ID: ${selected_session.studyId}<br>`)
        .append(`Accession: ${selected_session.accession}<br>`)
        .append('Description: ' + selected_session.studyDescription + '<br>')
        .append('Date: ' + studyDate + '<br>')
        .append(`Modality: ${selected_session.modality}<br>`)
        .append(`${selected_session.scans.size} scans in ${total_files} files (${(total_size / 1024 / 1024).toFixed(2)}MB)`);


    $('.tab-pane.active .js_next').removeClass('disabled');
}

$(document).on('click', 'button[data-session_id]', function(e){
    select_session_id($(this).data('session_id'));
    $('#session-selection').modal('hide');
});

function get_form_value(field, data) {
    return $(`a[data-${field}].selected`).data(data);
}


$.queue = {
    _timer: null,
    _queue: [],
    add: function(fn, context, time) {
        var setTimer = function(time) {
            $.queue._timer = setTimeout(function() {
                time = $.queue.add();
                if ($.queue._queue.length) {
                    setTimer(time);
                }
            }, time || 0);
        }

        if (fn) {
            $.queue._queue.push([fn, context, time]);
            if ($.queue._queue.length == 1) {
                setTimer(time);
            }
            return;
        }

        var next = $.queue._queue.shift();
        if (!next) {
            return 0;
        }
        next[0].call(next[1] || window);
        return next[2];
    },
    clear: function() {
        clearTimeout($.queue._timer);
        $.queue._queue = [];
    }
};

function getSizeAsPromised(pth) {
    return new Promise(function(resolve, reject) {
        getSize(pth, function(err, size) {
            if (err) { 
                reject(err);
            } else {
                let folder_size = (size / 1024 / 1024).toFixed(2);
                console.log('--->', pth, folder_size + ' MB');
                resolve(Math.round(size / 1024 / 1024));
            }
        });
    });
}

// TODO - remove (not used)
function dicomParseMime(_files) {
    let mime_types = [];
    for (let i = 0; i < _files.length; i++) {
        let file = _files[i]
        console.log(path.basename(file) + ':' + mime.lookup(file));
    }
}

function dicomParse(_files, root_path) {
    $.blockUI({
        message: '<h1>Processing...</h1>'
    });
            
    let errors = 0;
    let warnings = 0;

    let dicoms = [];
    let sessions = [];
    let series = [];

    session_map.clear();

    
    NProgress.start();
    let current_progress = 0.03;


    let $progress_bar = $('#dicom_parse_progress');
    $progress_bar.show().attr({
        value: 0,
        max: _files.length
    });

    let timer_start;
    $.queue.add(function(){
        timer_start = performance.now();
        console.time('dicomParse');
    }, this);


    let bundle_size = 50;

    let files_bundle = Math.ceil(_files.length / bundle_size);

    let files_parsed = [];

    // splitting for loop into multiple bundles ... to display progress 
    // ... because javascript doesn't let browser render updates while it's working
    for (let h = 0; h < files_bundle; h++) {
        let i_max = Math.min((h + 1) * bundle_size, _files.length);

        let parse_file_bundle = function() {
            for(let i = h * bundle_size; i < i_max; i++) {
                let file = _files[i];
                files_parsed.push(file);
                
                displayMessage(`---Reading file ${file}:`);

                // only parse dicom files or those of unknown mime type
                if (mime.lookup(file) === false || mime.lookup(file) === 'application/dicom') {
                    try {
                        const dicomFile = fs.readFileSync(file);
                        const dicom = dicomParser.parseDicom(dicomFile, { untilTag: '0x00324000' });           
                        
                        const studyInstanceUid = dicom.string('x0020000d');
                        
                        if (typeof studyInstanceUid !== 'undefined') {
                            const studyDescription = dicom.string('x00081030');
                            const studyId = dicom.string('x00200010');
                            
                            const seriesDescription = dicom.string('x0008103e');
                            const seriesInstanceUid = dicom.string('x0020000e');
                            const seriesNumber = dicom.string('x00200011');
                            
                            // ++++
                            const modality = dicom.string('x00080060');
                            const study_date = dicom.string('x00080020');
                            const study_time = dicom.string('x00080030');

                            const accession = dicom.string('x00080050');
                            // ++++
                
    
                            if (!session_map.has(studyInstanceUid)) {
                                session_map.set(studyInstanceUid, {
                                    studyId: studyId,
                                    studyInstanceUid: studyInstanceUid,
                                    studyDescription: studyDescription,
                                    modality: modality,
                                    accession: accession,
                                    date: study_date,
                                    time: study_time,
                                    scans: new Map()
                                });
                            }
                
                            if (!session_map.get(studyInstanceUid).scans.has(seriesInstanceUid)) {
                                session_map.get(studyInstanceUid).scans.set(seriesInstanceUid, []);
                            }
                            
                            let file_name = path.basename(file);
                            let file_size = getFilesizeInBytes(file);
                            let my_scans = session_map.get(studyInstanceUid).scans.get(seriesInstanceUid);
                            let filtered = my_scans.filter(el => el.filename === file_name && el.filesize === file_size);
            
                            // only add unique files
                            if (filtered.length === 0) {
                                my_scans.push({
                                    filepath: file,
                                    filename: file_name,
                                    filesize: file_size,
                                    seriesDescription: seriesDescription,
                                    seriesInstanceUid: seriesInstanceUid,
                                    seriesNumber: seriesNumber
                                }); 
                            }
                                       
                        }
                        
                    } catch (error) {
                        handleError(`There was an error processing the file ${file}`, error);
                        errors++;
                    }
                }

            }
        };

        let show_bundle_progress = function() {
            let progress = parseFloat( ((h+1)*bundle_size/_files.length).toFixed(2) ) - 0.01;

            if (progress > current_progress) {
                NProgress.set(progress);
                current_progress = progress;
                console.log('current_progress: ' + current_progress);
            }
    
            $progress_bar.attr('value', i_max);
        };

        $.queue.add(parse_file_bundle, this);
        $.queue.add(show_bundle_progress, this);
    }
    

    let display_results = function(){
        NProgress.done();

        //console.info(dicoms, 'studyInstanceUid: ', sessions, 'seriesInstanceUids: ',series);

        console.log('session_map size: ' + session_map.size);
        console.log(session_map);
        
        console.timeEnd('dicomParse');

        let info = 'Time: ' + ((performance.now() - timer_start)/1000).toFixed(2) + "s \n\n";
        info += 'Total sessions: ' + session_map.size + "\n";
        session_map.forEach(function(cur_session, key) {
            info += `** ${key} (scans: ${cur_session.scans.size})`;
            
            let sep = "\n------ ";
            cur_session.scans.forEach(function(scan, key) {
                var total_size = scan.reduce(function(prevVal, elem) {
                    return prevVal + elem.filesize;
                }, 0);

                info += sep + key + ` [imgs: ${scan.length}] {size: ${(total_size / 1024 / 1024).toFixed(2)}MB}`;
            });

            info += "\n\n";
        });

        swal(info)
    };

    // for testing only - skipping 
    // $.queue.add(display_results, this);

    let handle_results = function(){

        function find_common_path(paths) {
            if (paths.length === 0) {
                return '';
            }
            
            // find a common path
            let common_path = paths[0];
            let searching = paths.length === 1 ? false : true;

            while (common_path.length > 0 && searching) {
                for (let j = 1; j < paths.length; j++) {
                    let path_suffix = paths[j].substring(common_path.length);

                    if (paths[j].indexOf(common_path) !== 0 || (path_suffix.length > 0 && path_suffix.indexOf(path.sep) !== 0)) {
                        let last_path_separator = common_path.lastIndexOf(path.sep);
                        common_path = last_path_separator > 0 ? common_path.substring(0, last_path_separator) : '';
                        break;
                    }

                    // if no break has happened - we found our match
                    if (j == paths.length - 1) {
                        searching = false;
                    }
                    
                }
            }

            return common_path;
        }

        NProgress.done();

        console.log(`************************* session_map.size: ${session_map.size} ********************************`);
        
        switch (session_map.size) {
            case 0:
                resetSubsequentTabs();
                resseting_functions.get(1)();
                
                swal({
                    title: 'No DICOM files',
                    text: 'No DICOM files were found inside selected folder. Please choose another folder.',
                    icon: "warning",
                    dangerMode: true
                })


                break;
            
            case 1:
                let my_session_id;
                session_map.forEach(function(cur_session, key) {
                    my_session_id = key
                });

                select_session_id(my_session_id);
                $('.tab-pane.active .js_next').trigger('click');

                break;

            default:
                let tbl_data = [];
                session_map.forEach(function(cur_session, key) {
                    let paths = [];
                    cur_session.scans.forEach(function (files, scan_id) {                       
                        for (let i = 0; i < files.length; i++) {
                            let node_path = path.dirname(files[i].filepath)
                            let rel_dir_path = node_path.substring(root_path.length);
                            paths.push(rel_dir_path);
                        }
                    });
                    
                    console.log('=================== COMMON PATH '+ root_path + find_common_path(paths) +'=============================');
                    console.log(paths);
                    console.log('===============================================');
                    
                    let session_label = cur_session.studyId === undefined ? key : cur_session.studyId;

                    let session_data = {
                        id: key,
                        label: session_label,
                        root_path: root_path + find_common_path(paths),
                        scan_count: cur_session.scans.size,
                        action: ''
                    }

                    tbl_data.push(session_data);
                });

                _init_session_selection_table(tbl_data);
                $('#session-selection').modal('show');
        }

        $.unblockUI();

    };


    $.queue.add(handle_results, this);

    $.queue.add(function(){
        console.log(session_map);
        
    }, this);

}

function get_default_expt_label() {
    let subject_id = $('a[data-subject_id].selected').data('subject_label');
    let modality = session_map.get(selected_session_id).modality;
    
    let expt_label = subject_id.split(' ').join('_') + '_' + modality + '_';
    for (let i = 1; i < 10000; i++) {
        let my_expt_label = expt_label + i;
        if (defined_project_exp_labels.indexOf(my_expt_label) === -1) {
            expt_label = my_expt_label;
            break;
        }
    }
    console.log('EXPT_LABEL', expt_label);

    return expt_label;
}

function storeUpload(url_data, session_id, series_ids, anon_variables) {
    console.log('==== anon_variables ====', anon_variables);
    
    let project_id = url_data.project_id;
    let subject_id = url_data.subject_id;
    let expt_label = url_data.expt_label;

    let _files = [];
    let series = [];

    let total_size = 0;
    for (let i = 0; i < series_ids.length; i++) {
        let scan_series = session_map.get(session_id).scans.get(series_ids[i]);
        series.push(scan_series)
        
        total_size = scan_series.reduce(function(prevVal, item) {
            return prevVal + item.filesize;
        }, total_size);

        let files = scan_series.map(function(item){
            return item.filepath;
        });
        _files = _files.concat(files);
    }
    // -----------------------------------------------------

    selected_session = session_map.get(session_id);
    table_rows = [];
    selected_session.scans.forEach(function(scan, key) {
        console.log(key);
        
        if (series_ids.indexOf(key) >= 0) {
            let scan_size = scan.reduce(function(prevVal, elem) {
                return prevVal + elem.filesize;
            }, 0);
            total_size += scan_size;
            //total_files += scan.length;
            
            // use scan description from the last one (or any other from the batch)
            let scans_description = scan[0].seriesDescription;
            let series_number = scan[0].seriesNumber
            console.log(scan);
            
            table_rows.push({
                id: Helper.uuidv4(),
                series_number: series_number,
                series_id: key,
                description: scans_description,
                progress: 0,
                count: scan.length,
                size: scan_size
            })
        } else {
            console.log('Preskacemo ' + key);
        }       
        
    });

    let studyDate = selected_session.date ? 
        selected_session.date.substr(0, 4) + '-' +
        selected_session.date.substr(4, 2) + '-' +
        selected_session.date.substr(6, 2) : '';
    
    let studyTime = selected_session.time ? 
        selected_session.time.substr(0, 2) + ':' +
        selected_session.time.substr(2, 2) + ':' +
        selected_session.time.substr(4, 2) : '';


    let upload_digest = {
        id: Helper.uuidv4(),
        url_data: url_data,
        anon_variables: anon_variables,
        session_id: session_id,
        session_data: {
            studyId: selected_session.studyId,
            studyInstanceUid: selected_session.studyInstanceUid,
            studyDescription: selected_session.studyDescription,
            modality: selected_session.modality,
            accession: selected_session.accession,
            studyDate: studyDate,
            studyTime: studyTime
        },
        series_ids: series_ids,
        series: series,
        //_files: _files,
        total_size: total_size,
        //user_auth: user_auth,
        xnat_server: xnat_server,
        user: auth.get_current_user(),
        transfer_start: Helper.unix_timestamp(),
        table_rows: table_rows,
        status: 0,
        canceled: false
    };

    let my_transfers = store.get('transfers.uploads');

    my_transfers.push(upload_digest);
    store.set('transfers.uploads', my_transfers);
    
    console.log(upload_digest);

    ipc.send('start_upload');
    
    ipc.send('redirect', 'progress.html');

    setTimeout(function(){
        $('#nav-upload-tab').trigger('click');
    }, 40);
    
    return;

    // -----------------------------------------------------



    summary_add(project_id, 'PROJECT_ID');
    summary_add(subject_id, 'SUBJECT_ID');
    summary_add(expt_label, 'EXPT_LABEL');
    summary_add(session_id, 'STUDY_ID');
    summary_add(series_ids.length, 'SCANS');
    summary_add(_files.length, 'FILES');
    summary_add(`${(total_size / 1024 / 1024).toFixed(2)}MB`, 'FILESIZE');

    console.log(_files);
    

    //swal(project_id + "\n" + subject_id + "\nFiles: " + _files.length);

    

    copy_and_anonymize(_files)
        .then((res) => {
            summary_add(res.directory, 'Anonymization dir');
            summary_add(res.copy_success.length, 'Anonymized files');
            summary_add(res.copy_error.length, 'Anonymization errors');

            // todo add additional logic for errors
            if (res.copy_error.length == 0) {
                zip_and_upload(res.directory, res.copy_success, url_data);
            } else {
                let error_file_list = '';
                for(let i = 0; i < res.copy_error.length; i++) {
                    error_file_list += res.copy_error[i].file + "\n * " + res.copy_error[i].error + "\n\n";
                }

                swal({
                    title: `Anonymization Error`,
                    text: `An error occured during anonymization of the folowing files: \n${error_file_list}`,
                    icon: "error",
                    dangerMode: true
                })
            }
        })
    
}



function getFilesizeInBytes(filename) {
    const stats = fs.statSync(filename)
    const fileSizeInBytes = stats.size
    return fileSizeInBytes
}

// recursive directory listing
const walkSync = (dir, fileList = []) => {
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file)
  
      if (fs.statSync(filePath).isDirectory()) {
        walkSync(filePath, fileList)
      } else {
        fileList.push(filePath)
      }
      
    })
    return fileList;
}

function append_subject_row(subject){
    let group_tag = subject.group ? `${subject.group}` : `/`
    $('#subject-session').append(`
        <li>
            <a href="javascript:void(0)" 
                data-subject_uri="${subject.URI}"
                data-subject_insert_date="${subject.insert_date}"
                data-subject_label="${subject.label}"
                data-subject_id="${subject.ID}">
                ${subject.label} <span class="meta_key">ID: ${subject.ID}</span>
                <span class="meta_value">Group: ${group_tag}</span>
            </a>
        </li>
    `)
}

const no_upload_privileges_warning = () => {
    swal({
        title: `Warning: No projects to display`,
        text: `There are no projects on this XNAT server that you have permission to upload to.`,
        icon: "warning",
        dangerMode: true,
        button: 'Cancel'
    })
    .then((proceed) => {
        console.log(proceed);
    });
}


// allow_create_subject
function global_allow_create_subject() {
    return axios.get(xnat_server + '/data/config/applet/allow-create-subject?contents=true&accept-not-found=true', {
        auth: user_auth
    });
}


function project_allow_create_subject(project_id) {
    return axios.get(xnat_server + '/data/config/projects/'+project_id+'/applet/allow-create-subject?contents=true&accept-not-found=true', {
        auth: user_auth
    });
}

const handle_create_subject_response = (res) => {
    console.log( '===========', typeof res.data, '===========');
    
    let allow_create_subject = (typeof res.data === 'boolean') ? res.data : (res.data === '' || res.data.toLowerCase() === 'true');
    console.log('allow_create_subject:', allow_create_subject, `(${res.data})`);
    $('button[data-target="#new-subject"]').prop('disabled', !allow_create_subject);
};

// require_date
function global_require_date() {
    return axios.get(xnat_server + '/data/config/applet/require-date?contents=true&accept-not-found=true', {
        auth: user_auth
    });
}

function project_require_date(project_id) {
    return axios.get(xnat_server + '/data/config/projects/'+project_id+'/applet/require-date?contents=true&accept-not-found=true', {
        auth: user_auth
    });
}

const handle_global_require_date = (res) => {
    
    
    global_date_required = (typeof res.data === 'boolean') ? res.data : (res.data.toLowerCase() !== 'false' && res.data !== '');
    console.log('========== handle_global_require_date ===========', global_date_required, $('#nav-date', 'a[href="#nav-date"]').length);
    
    set_date_tab(global_date_required)
}

const handle_require_date = (res) => {
    console.log( '===========', typeof res.data, '===========');
    if (res.data === '') {
        date_required = global_date_required;
    } else {
        date_required = (typeof res.data === 'boolean') ? res.data : (res.data.toLowerCase() !== 'false');
    }
    
    console.log('date_required:', date_required, `(${res.data})`);
    $('#upload_session_date').prop('required', date_required);
    

    let next_button = $('#upload_session_date').closest('.tab-pane').find('.js_next');
    if (date_required) {
        next_button.addClass('disabled'); 
    } else {
        next_button.removeClass('disabled');     
    }

    set_date_tab(date_required)
    
};

const set_date_tab = (date_required) => {
    if (date_required) {
        $('#nav-date, a[href="#nav-date"]').each(function(){
            console.log($(this));
            
            $(this).removeClass('hidden')
        })
    } else {
        $('#nav-date, a[href="#nav-date"]').each(function(){
            $(this).addClass('hidden')
        })
    }
}

const handle_error = (err) => {
    console.log(err, err.response);
};

//================================

function promise_projects() {
    return axios.get(xnat_server + '/data/projects?permissions=edit&dataType=xnat:subjectData', {
    //return axios.get(xnat_server + '/data/projects?accessible=true', {
        auth: user_auth
    });
}

function promise_project_experiments(project_id) {
    return axios.get(xnat_server + '/data/projects/'+project_id+'/experiments?columns==ID,label,xnat:experimentData/meta/status', {
        auth: user_auth
    });
}

function promise_subjects(project_id) {
    return axios.get(xnat_server + '/data/projects/' + project_id + '/subjects?columns=group,insert_date,insert_user,project,label', {
        auth: user_auth
    })
    
}

function promise_project_subject(project_id, subject_label) {
    return axios.get(xnat_server + '/data/projects/' + project_id + '/subjects/' + subject_label + '?format=json', {
        auth: user_auth
    })
}

function promise_create_project_subject(project_id, subject_label, group) {
    return axios.put(xnat_server + '/data/projects/' + project_id + '/subjects/' + subject_label + '?group=' + group + '&event_reason=XNAT+Application' + '&XNAT_CSRF=' + csrfToken, {
        auth: user_auth
    })
}


const displayMessage = (text = '', isError = false) => {
    if (isError) {
        console.error(text)
    } else {
        console.info(text);
    }
};

const handleError = (message, error = '') => {
    if (!error) {
        displayMessage(message, true);
    } else if (!error.message) {
        displayMessage(`${message}: ${error}`.trim(), true);
    } else {
        displayMessage(`${message}: ${error.message}`.trim(), true);
    }
};

function resetSubsequentTabs() {
    console.log('resseting tabs after: ' + $('#upload-section #nav-tab .nav-link.active').index());
    resetTabsAfter($('#upload-section #nav-tab .nav-link.active').index());
}


function resetTabsAfter(tabIndex) {
    resseting_functions.forEach(function(reset, key) {
        if (key > tabIndex) {
            $('#upload-section #nav-tab .nav-link').eq(key).addClass('disabled');
            reset();
        }
    })
}

const summary_clear = () => {
    $('#summary_info').html('');
}

const summary_add = (text, label = '') => {
    let label_html = label ? `<b>${label}: </b>` : '';

    $('#summary_info').append(`<p>${label_html} ${text}</p>`);
}